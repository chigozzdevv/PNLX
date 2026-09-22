import { loadEnv } from "@/config/env";
import { NotesService } from "@/features/notes/notes.service";
import { readMakerNotes, transitionMakerNoteStatus } from "@/shared/maker-note-store";
import { createExecutorAsync } from "@/workers/executor/executor.worker";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createOnchainRelay } from "@/workers/onchain/onchain.worker";
import { createProver } from "@/workers/prover/prover.worker";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import type { Hex } from "@pnlx/protocol-types";

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
  if (execute && !argv.includes("--matcher-stopped")) {
    throw new Error("stop the matcher before executing maker note withdrawals");
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
  const onchain = createOnchainRelay(relayer, {
    deployment,
    enabled: true,
    resolveProofArtifact: (proof) => prover.artifactFor(proof),
  });
  const notes = (await readMakerNotes()) as MakerNote[];
  const owned = notes.filter((note) => String(note.walletAddress ?? "").toUpperCase() === maker);
  const available = owned.filter((note) => note.status === "available" || note.status === "withdrawing");
  const locked = owned.filter((note) => note.status === "locked");
  if (locked.length > 0) throw new Error(`${locked.length} maker notes remain locked`);
  const summary = {
    availableAmount: available.reduce((sum, note) => sum + BigInt(note.amount), 0n).toString(),
    availableNotes: available.length,
    recoveringNotes: available.filter((note) => note.status === "withdrawing").length,
    maker,
    mode: execute ? "execute" : "inspect",
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!execute || available.length === 0) return;

  const vaultId = deployment.contracts["liquidity-vault"];
  for (const [method, expected] of [
    ["asset", env.collateralTokenContract],
    ["maker", maker],
    ["paused", "true"],
  ]) {
    const result = await relayer.readAsync({
      kind: "contract-invoke",
      payload: { contractId: vaultId, functionName: method, send: "no" },
    });
    const actual = String(parseOutput(result.output));
    if (actual !== expected) throw new Error(`vault ${method} does not match maker withdrawal configuration`);
  }

  const assetDigest = onchain.tokenDigest(env.collateralTokenContract);
  const recipientDigest = onchain.tokenDigest(maker);
  const executor = await createExecutorAsync({
    mongo: {
      collection: env.mongodbCollection,
      database: env.mongodbDatabase,
      documentId: env.stellarNetwork,
      ensureIndexes: true,
      uri: env.mongodbUri,
    },
    privateMatchingRequired: env.privateMatchingRequired,
  });
  const service = new NotesService(executor, prover, env, onchain, relayer);
  let recovered = 0n;
  for (const note of available) {
    if (!note.commitment || !note.noteNullifier || !note.assetDigest || !note.blinding ||
      !note.ownerDigest || !note.rhoDigest || !note.spendSecretDigest || !note.amount) {
      throw new Error("incomplete maker note record");
    }
    if (note.assetDigest.toLowerCase() !== assetDigest.toLowerCase()) {
      throw new Error(`maker note asset mismatch: ${note.commitment}`);
    }
    if (note.status === "available") {
      const claimed = await transitionMakerNoteStatus(note.commitment, "available", "withdrawing");
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
      await transitionMakerNoteStatus(note.commitment, "withdrawing", "spent");
      throw new Error(`maker note was already spent on-chain: ${note.commitment}`);
    }
    const membership = executor.store.marginMembershipProof(note.commitment);
    const amount = BigInt(note.amount);
    const withdrawal = service.withdrawAsset({
      assetDigest: note.assetDigest,
      blinding: note.blinding,
      changeBlinding: "0x0",
      changeRhoDigest: "0x0",
      noteAmount: amount,
      noteCommitment: note.commitment,
      nullifier: note.noteNullifier,
      ownerDigest: note.ownerDigest,
      pathIndices: membership.indices,
      pathSiblings: membership.siblings,
      recipient: recipientDigest,
      recipientAddress: maker,
      recipientDigest,
      rhoDigest: note.rhoDigest,
      root: membership.root,
      spendSecretDigest: note.spendSecretDigest,
      token: env.collateralTokenContract,
      tokenDigest: assetDigest,
      withdrawAmount: amount,
    });
    const store = executor.store as typeof executor.store & { flush?: () => Promise<void> };
    await store.flush?.();
    const recorded = await transitionMakerNoteStatus(note.commitment, "withdrawing", "spent");
    if (!recorded) throw new Error(`maker note status changed after withdrawal: ${note.commitment}`);
    recovered += amount;
    process.stdout.write(`${JSON.stringify({ amount: note.amount, commitment: note.commitment, nullifier: withdrawal.nullifier })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ recoveredAmount: recovered.toString(), maker })}\n`);
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output.trim());
  } catch {
    return output.trim();
  }
}
