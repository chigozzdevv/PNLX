import { loadEnv } from "@/config/env";
import { ownerCommitment } from "@pnlx/crypto";
import { readMakerNotes, recordMakerNoteRecovery, transitionMakerNoteStatus } from "@/shared/maker-note-store";
import { allocationId, normalizedHash, readVaultMakerAllocations } from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createProver } from "@/workers/prover/prover.worker";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { createExecutorAsync } from "@/workers/executor/executor.worker";
import type { Hex } from "@pnlx/protocol-types";
import { authHeadersFor, get, localApiOrigin, post, type SmokeApp } from "../smoke/custody";
import { assertSuccessfulTransaction, sameHex32 } from "./register-vault-maker-note";

interface MakerNote {
  amount: string;
  assetDigest: Hex;
  blinding: Hex;
  commitment: Hex;
  noteNullifier: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  spendSecretDigest: Hex;
  status: string;
  walletAddress: string;
  [key: string]: string | number | undefined;
}

if (import.meta.main) {
  await withdrawMakerNotes(process.argv.slice(2));
}

export async function withdrawMakerNotes(argv: string[]): Promise<void> {
  const execute = argv.includes("--execute");
  const draining = argv.includes("--allocation-draining");
  const closedOutput = argv.includes("--closed-output");
  const noteFlag = argv.indexOf("--note-commitment");
  const noteCommitment = noteFlag < 0 ? undefined : argv[noteFlag + 1];
  if (closedOutput && (!noteCommitment || !/^0x[0-9a-fA-F]{64}$/.test(noteCommitment) || draining)) {
    throw new Error("closed maker output recovery requires one note commitment without allocation draining");
  }
  const apiFlag = argv.indexOf("--api-url");
  const apiUrl = apiFlag < 0 ? undefined : localApiOrigin(argv[apiFlag + 1] ?? "");
  const makerSourceFlag = argv.indexOf("--maker-source");
  const makerSource = makerSourceFlag < 0 ? undefined : argv[makerSourceFlag + 1];
  if (execute && (!apiUrl || !makerSource || makerSource.startsWith("--"))) {
    throw new Error("executing maker note recovery requires --api-url and --maker-source");
  }
  if (execute && !argv.includes("--matcher-stopped") && !draining && !closedOutput) {
    throw new Error("stop the matcher or drain the allocation before executing maker note withdrawals");
  }
  const env = loadEnv();
  const maker = env.makerWalletAddress?.trim().toUpperCase();
  if (!maker || !/^G[A-Z2-7]{55}$/.test(maker)) {
    throw new Error("MAKER_WALLET_ADDRESS must be the dedicated vault maker account");
  }
  if (env.stellarNetwork !== "testnet" || env.stellarRelayerMode !== "stellar-cli" || !env.stellarOnchainRelay) {
    throw new Error("Testnet Stellar on-chain relay is required");
  }
  if (!env.collateralTokenContract || !env.mongodbUri) {
    throw new Error("collateral token and MongoDB must be configured");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  if (!deployment?.contracts["liquidity-vault"] || !deployment.contracts["shielded-pool"]) {
    throw new Error("vault and shielded pool deployments are required");
  }
  const allocationFlag = argv.indexOf("--allocation-tx");
  const allocationTx = allocationFlag < 0 ? undefined : argv[allocationFlag + 1];
  if (allocationFlag >= 0 && (!allocationTx || allocationTx.startsWith("--"))) {
    throw new Error("--allocation-tx requires a hash");
  }
  const scopedAllocationId = allocationTx
    ? allocationId(deployment.contracts["liquidity-vault"], normalizedHash(allocationTx))
    : undefined;
  if ((draining || closedOutput) && !scopedAllocationId) {
    throw new Error("scoped maker recovery requires --allocation-tx");
  }
  if (scopedAllocationId) {
    const allocation = (await readVaultMakerAllocations()).find((item) => item.id === scopedAllocationId);
    if (!allocation || (draining ? allocation.status !== "draining" :
      closedOutput ? allocation.status !== "outstanding" : allocation.status === "closed") ||
      allocation.maker !== maker ||
      allocation.asset !== env.collateralTokenContract) {
      throw new Error("outstanding allocation for configured maker and asset was not found");
    }
  }
  const relayer = createRelayer({
    config: {
      commandTimeoutMs: env.stellarCommandTimeoutMs,
      mode: "stellar-cli",
      network: env.stellarNetwork,
      networkPassphrase: env.stellarNetworkPassphrase,
      rpcUrl: env.stellarRpcUrl,
      source: env.stellarSource,
    },
  });
  const prover = createProver();
  const notes = (await readMakerNotes()) as MakerNote[];
  const owned = notesForMakerRecovery(notes, maker, scopedAllocationId)
    .filter((note) => !noteCommitment || note.commitment === noteCommitment);
  if (closedOutput) {
    if (owned.length !== 1 || owned[0]?.status !== "draining" && owned[0]?.status !== "withdrawing" ||
      !owned[0]?.vaultParentCommitment || !owned[0]?.closePositionCommitment || !owned[0]?.closeTxHash) {
      throw new Error("closed maker output is not reserved for recovery");
    }
    const executor = await createExecutorAsync({ mongo: {
      collection: env.mongodbCollection, database: env.mongodbDatabase,
      documentId: env.stellarNetwork, ensureIndexes: false, uri: env.mongodbUri!,
    }, privateMatchingRequired: env.privateMatchingRequired });
    try {
      const position = executor.store.positionsFor(ownerCommitment(maker)).find(
        (item) => item.positionCommitment === owned[0]!.closePositionCommitment,
      );
      const close = position?.closeCommitment
        ? executor.store.positionCloses.get(position.closeCommitment) : undefined;
      if (position?.status !== "closed" || position.marginOutputCommitment !== noteCommitment ||
        !close || close.settlementTxHash !== owned[0]!.closeTxHash) {
        throw new Error("maker close output does not match a confirmed position close");
      }
      await assertSuccessfulTransaction(env.stellarRpcUrl, close.settlementTxHash);
    } finally {
      await (executor.store as { close?: () => Promise<void> }).close?.();
    }
  }
  const available = owned.filter((note) => note.status === "available" || note.status === "draining" ||
    note.status === "withdrawing");
  const locked = owned.filter((note) => note.status === "locked");
  if (locked.length > 0 && !draining && !closedOutput) throw new Error(`${locked.length} maker notes remain locked`);
  if (draining && owned.some((note) => note.status === "pending" || note.status === "available")) {
    throw new Error("allocation drain has not claimed every unspent maker note");
  }
  const summary = {
    availableAmount: available.reduce((sum, note) => sum + BigInt(note.amount), 0n).toString(),
    availableNotes: available.length,
    lockedNotes: locked.length,
    recoveringNotes: available.filter((note) => note.status === "withdrawing").length,
    maker,
    mode: execute ? "execute" : "inspect",
    ...(scopedAllocationId ? { allocationId: scopedAllocationId } : {}),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!execute || available.length === 0) return;

  const vaultId = deployment.contracts["liquidity-vault"];
  for (const [method, expected] of [
    ["asset", env.collateralTokenContract],
    ["maker", maker],
  ]) {
    const result = await relayer.readAsync({
      kind: "contract-invoke",
      payload: { contractId: vaultId, functionName: method, send: "no" },
    });
    const actual = String(parseOutput(result.output));
    if (actual !== expected) throw new Error(`vault ${method} does not match maker withdrawal configuration`);
  }

  const app: SmokeApp = { origin: apiUrl!, handle: (request) => fetch(request) };
  const authHeaders = await authHeadersFor(app, makerSource!, maker, env);
  const assetDigest = String((await get(app,
    `/notes/address-digest?address=${encodeURIComponent(env.collateralTokenContract)}`, authHeaders)).digest) as Hex;
  const recipientDigest = String((await get(app,
    `/notes/address-digest?address=${encodeURIComponent(maker)}`, authHeaders)).digest) as Hex;
  let recovered = 0n;
  for (const note of available) {
    if (!note.commitment || !note.noteNullifier || !note.assetDigest || !note.blinding ||
      !note.ownerDigest || !note.rhoDigest || !note.spendSecretDigest || !note.amount) {
      throw new Error("incomplete maker note record");
    }
    if (!sameHex32(note.assetDigest, assetDigest)) {
      throw new Error(`maker note asset mismatch: ${note.commitment}`);
    }
    if (note.status === "available" || note.status === "draining") {
      const claimed = await transitionMakerNoteStatus(note.commitment, note.status, "withdrawing");
      if (!claimed) throw new Error(`maker note changed before withdrawal: ${note.commitment}`);
    }
    const isSpent = await relayer.readAsync({
      kind: "contract-invoke",
      payload: {
        args: ["--nullifier", note.noteNullifier.replace(/^0x/, "")],
        contractId: deployment.contracts["shielded-pool"],
        functionName: "is_spent",
        send: "no",
      },
    });
    const spent = parseOutput(isSpent.output);
    if (spent !== true && spent !== false) throw new Error("invalid shielded pool spent response");
    if (spent) {
      throw new Error(`maker note ${note.commitment} was spent before recovery could be verified`);
    }
    const balanceBefore = await makerBalance();
    const membershipResponse = await get(app,
      `/notes/membership?commitment=${encodeURIComponent(note.commitment)}`, authHeaders);
    const membership = membershipResponse.note as { membershipProof?: {
      indices: boolean[]; root: Hex; siblings: Hex[];
    } };
    if (!membership?.membershipProof) throw new Error(`maker note ${note.commitment} has no membership proof`);
    const amount = BigInt(note.amount);
    const withdrawal = prover.proveWithdrawal({
      assetDigest: note.assetDigest,
      blinding: note.blinding,
      changeBlinding: "0x0",
      changeRhoDigest: "0x0",
      noteAmount: amount,
      noteCommitment: note.commitment,
      nullifier: note.noteNullifier,
      ownerDigest: note.ownerDigest,
      pathIndices: membership.membershipProof.indices,
      pathSiblings: membership.membershipProof.siblings,
      recipient: recipientDigest,
      rhoDigest: note.rhoDigest,
      root: membership.membershipProof.root,
      spendSecretDigest: note.spendSecretDigest,
      tokenDigest: assetDigest,
      withdrawAmount: amount,
    });
    await post(app, "/notes/withdraw-asset/proven", {
      ...withdrawal,
      recipientAddress: maker,
      token: env.collateralTokenContract,
    }, authHeaders);
    let confirmed = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = await relayer.readAsync({ kind: "contract-invoke", payload: {
        args: ["--nullifier", note.noteNullifier.replace(/^0x/, "")],
        contractId: deployment.contracts["shielded-pool"], functionName: "is_spent", send: "no",
      } });
      if (parseOutput(state.output) === true && await makerBalance() - balanceBefore === amount) {
        confirmed = true;
        break;
      }
      await Bun.sleep(1_000);
    }
    if (!confirmed) throw new Error(`maker note ${note.commitment} withdrawal did not reconcile on-chain`);
    await recordMakerNoteRecovery(note.commitment, note.amount);
    recovered += amount;
    process.stdout.write(`${JSON.stringify({ amount: note.amount, commitment: note.commitment, nullifier: withdrawal.nullifier })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ recoveredAmount: recovered.toString(), maker })}\n`);

  async function makerBalance(): Promise<bigint> {
    const result = await relayer.readAsync({ kind: "contract-invoke", payload: {
      args: ["--id", maker!], contractId: env.collateralTokenContract!,
      functionName: "balance", send: "no",
    } });
    const amount = parseOutput(result.output);
    if (typeof amount !== "string" && typeof amount !== "number") throw new Error("invalid maker balance");
    return BigInt(amount);
  }
}

export function notesForMakerRecovery<T extends { walletAddress: string; vaultAllocationId?: string }>(
  notes: T[],
  maker: string,
  scopedAllocationId?: string,
): T[] {
  return notes.filter((note) =>
    note.walletAddress.trim().toUpperCase() === maker &&
    (!scopedAllocationId || note.vaultAllocationId === scopedAllocationId));
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output.trim());
  } catch {
    return output.trim();
  }
}
