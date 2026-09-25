import { ownerCommitment } from "@pnlx/crypto";
import { loadCircuit } from "@pnlx/proof-system";
import type { Hex, PositionLifecycleRecord } from "@pnlx/protocol-types";
import { loadEnv } from "@/config/env";
import { reconstructPositionOpening } from "@/features/account-keys/account-key-recovery";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";
import { preparePairedMakerClose } from "@/features/position-closes/vault-maker-pair";
import {
  finalizePendingMakerCloseOutput,
  insertPendingMakerNote,
  readMakerNotes,
  type StoredMakerNoteRecord,
} from "@/shared/maker-note-store";
import { readVaultMakerAllocations, type VaultMakerAllocation } from "@/shared/vault-maker-backing";
import { withVaultMakerLease } from "@/shared/vault-maker-lease";
import type { ProtocolStore } from "@/shared/state/store";
import { createExecutorAsync } from "@/workers/executor/executor.worker";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createOnchainRelay } from "@/workers/onchain/onchain.worker";
import { createProver } from "@/workers/prover/prover.worker";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { assertSuccessfulTransaction } from "./register-vault-maker-note";
import { settleVaultMakerPosition } from "./settle-vault-maker-position";
import { withdrawMakerNotes } from "./withdraw-maker-notes";
import { authHeadersFor, localApiOrigin, type SmokeApp } from "../smoke/custody";

const warnedMarkMismatch = new Set<Hex>();

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string): string => {
    const index = args.indexOf(flag);
    const result = args[index + 1];
    if (index < 0 || !result || result.startsWith("--")) throw new Error(`${flag} is required`);
    return result;
  };
  const position = value("--position") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(position)) throw new Error("--position requires a commitment");
  const env = loadEnv();
  const vault = loadDeploymentRegistry(env.stellarDeploymentFile)?.contracts["liquidity-vault"];
  if (!env.mongodbUri || !vault) throw new Error("maker vault configuration is required");
  await withVaultMakerLease(env.mongodbUri, env.mongodbDatabase,
    `${env.stellarNetwork}:${vault}`, async (assertLease) => {
      const changed = await reconcileOneMakerPosition({
        apiUrl: localApiOrigin(value("--api-url")),
        assertLease,
        allowIndependentMark: args.includes("--close-at-current-mark"),
        makerSource: value("--maker-source"),
        operatorSource: value("--operator-source"),
        manualMakerPositionCommitment: position,
      });
      if (!changed) throw new Error("specified maker position is not eligible for reconciliation");
    });
}

type MakerNote = StoredMakerNoteRecord & {
  assetDigest: Hex;
  commitment: Hex;
  lockedByIntentCommitment: Hex;
  status: string;
  vaultAllocationId: string;
  walletAddress: string;
};

export interface MakerPositionCloseCandidate {
  allocation: VaultMakerAllocation;
  clientPosition: PositionLifecycleRecord;
  makerNote: MakerNote;
  makerPosition: PositionLifecycleRecord;
  output?: StoredMakerNoteRecord;
  principal: bigint;
}

export function makerPositionsReadyForReconciliation(
  store: ProtocolStore,
  notes: StoredMakerNoteRecord[],
  allocations: VaultMakerAllocation[],
  maker: string,
  fullCloseCircuitHash?: Hex,
): MakerPositionCloseCandidate[] {
  const activeAllocations = new Map(allocations
    .filter((allocation) => allocation.status !== "closed" && allocation.maker === maker)
    .map((allocation) => [allocation.id, allocation]));
  const positions = store.positionsFor(ownerCommitment(maker));
  const byCommitment = store.positionLifecycle;
  const candidates: MakerPositionCloseCandidate[] = [];
  for (const note of notes) {
    if (note.status !== "spent" || note.recoveredAmount ||
      typeof note.lockedByIntentCommitment !== "string" ||
      typeof note.commitment !== "string" || typeof note.vaultAllocationId !== "string" ||
      note.walletAddress !== maker) continue;
    const allocation = activeAllocations.get(note.vaultAllocationId);
    if (!allocation) continue;
    for (const makerPosition of positions.filter((position) =>
      position.sourceIntentCommitment === note.lockedByIntentCommitment &&
      position.status !== "liquidated")) {
      const settlement = [...store.settlements.values()].find(
        (item) => item.settlementDigest === makerPosition.settlementDigest,
      );
      const index = settlement?.newCommitments.indexOf(makerPosition.positionCommitment) ?? -1;
      if (!settlement || index < 0 || settlement.newCommitments.length % 2 !== 0) continue;
      const paired = settlement.newCommitments[index ^ 1];
      const clientPosition = paired ? byCommitment.get(paired) : undefined;
      const pairIndex = Math.floor(index / 2);
      const matchedIntents = [settlement.makerIntents[pairIndex], settlement.takerIntents[pairIndex]];
      if (!clientPosition || clientPosition.ownerCommitment === makerPosition.ownerCommitment ||
        clientPosition.status !== "closed" || !clientPosition.closeCommitment ||
        clientPosition.batchId !== makerPosition.batchId ||
        clientPosition.marketId !== makerPosition.marketId ||
        clientPosition.settlementDigest !== makerPosition.settlementDigest ||
        !matchedIntents.includes(clientPosition.sourceIntentCommitment) ||
        !matchedIntents.includes(makerPosition.sourceIntentCommitment) ||
        !store.positionCloses.get(clientPosition.closeCommitment)?.settlementTxHash ||
        (fullCloseCircuitHash &&
          store.positionCloses.get(clientPosition.closeCommitment)?.proof.circuitHash !== fullCloseCircuitHash)) continue;
      const opening = reconstructPositionOpening(store, makerPosition);
      if (!opening) continue;
      const principal = opening.margin + (opening.entryFee ?? 0n);
      if (principal <= 0n || principal > BigInt(String(note.amount))) continue;
      const output = notes.find((candidate) => candidate.closePositionCommitment ===
        makerPosition.positionCommitment && candidate.vaultAllocationId === allocation.id &&
        candidate.vaultParentCommitment === note.commitment &&
        candidate.walletAddress === maker && candidate.token === allocation.asset);
      if (output?.vaultSettlementTxHash) continue;
      if (makerPosition.status === "closed" &&
        (!output || makerPosition.marginOutputCommitment !== output.commitment)) continue;
      if (makerPosition.status === "open" && output && output.status !== "pending") continue;
      candidates.push({ allocation, clientPosition, makerNote: note as MakerNote,
        makerPosition, output, principal });
    }
  }
  return candidates.sort((a, b) => a.clientPosition.updatedAt - b.clientPosition.updatedAt);
}

export async function reconcileOneMakerPosition(input: {
  apiUrl: string;
  allowIndependentMark?: boolean;
  assertLease?: () => void;
  makerSource: string;
  operatorSource: string;
  manualMakerPositionCommitment?: Hex;
}): Promise<boolean> {
  if (input.allowIndependentMark && !input.manualMakerPositionCommitment) {
    throw new Error("independent maker close requires an explicitly selected position");
  }
  const env = loadEnv();
  if (!env.mongodbUri || !env.makerWalletAddress || !env.collateralTokenContract ||
    env.stellarNetwork !== "testnet" || !env.stellarOnchainRelay) {
    throw new Error("Testnet maker, vault, and MongoDB configuration are required");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  if (!deployment?.contracts["liquidity-vault"] || !deployment.contracts["shielded-pool"]) {
    throw new Error("vault and shielded pool deployments are required");
  }
  const executor = await createExecutorAsync({ mongo: {
    collection: env.mongodbCollection, database: env.mongodbDatabase,
    documentId: env.stellarNetwork, ensureIndexes: false, uri: env.mongodbUri,
  }, privateMatchingRequired: env.privateMatchingRequired });
  try {
    const notes = await readMakerNotes();
    const allocations = (await readVaultMakerAllocations()).filter((allocation) =>
      allocation.vault === deployment.contracts["liquidity-vault"] &&
      allocation.asset === env.collateralTokenContract);
    const candidates = makerPositionsReadyForReconciliation(
      executor.store, notes, allocations, env.makerWalletAddress.trim().toUpperCase(),
      input.manualMakerPositionCommitment ? undefined : loadCircuit(process.cwd(), "position-close").sourceHash,
    );
    const selected = input.manualMakerPositionCommitment
      ? candidates.filter((item) => item.makerPosition.positionCommitment === input.manualMakerPositionCommitment)
      : candidates;
    for (const candidate of selected) {
      const clientClose = executor.store.positionCloses.get(candidate.clientPosition.closeCommitment!);
      await assertSuccessfulTransaction(env.stellarRpcUrl, clientClose!.settlementTxHash!);
      const makerPosition = candidate.makerPosition;
      if (makerPosition.status === "open") {
        if (!input.allowIndependentMark) continue;
        if (candidate.output) {
          throw new Error(`maker position ${makerPosition.positionCommitment} has an unresolved pending close output`);
        }
        input.assertLease?.();
        if (await closeMakerPosition(candidate, executor, input, env, deployment)) return true;
        continue;
      }
      const output = candidate.output!;
      const makerClose = executor.store.positionCloses.get(makerPosition.closeCommitment!);
      if (!makerClose?.settlementTxHash || output.closeTxHash &&
        output.closeTxHash !== makerClose.settlementTxHash) {
        throw new Error("maker close transaction does not match its output note");
      }
      await assertSuccessfulTransaction(env.stellarRpcUrl, makerClose.settlementTxHash);
      if (output.status === "pending") {
        await finalizePendingMakerCloseOutput(String(output.commitment), makerClose.settlementTxHash);
        return true;
      }
      if (candidate.allocation.status === "draining") continue;
      if (output.status === "draining" || output.status === "withdrawing") {
        input.assertLease?.();
        await withdrawMakerNotes(["--allocation-tx", candidate.allocation.allocationTxHash,
          "--note-commitment", String(output.commitment), "--closed-output", "--execute",
          "--api-url", input.apiUrl, "--maker-source", input.makerSource]);
        return true;
      }
      if (output.status === "spent" && output.recoveredAmount) {
        input.assertLease?.();
        await settleVaultMakerPosition({ allocationId: candidate.allocation.id,
          closeTxHash: makerClose.settlementTxHash, noteCommitment: String(output.commitment) as Hex,
          operatorSource: input.operatorSource, positionCommitment: makerPosition.positionCommitment,
          principal: candidate.principal });
        return true;
      }
      throw new Error("maker close output has not reached a recoverable state");
    }
    return false;
  } finally {
    await (executor.store as { close?: () => Promise<void> }).close?.();
  }
}

async function closeMakerPosition(
  candidate: MakerPositionCloseCandidate,
  executor: Awaited<ReturnType<typeof createExecutorAsync>>,
  input: { apiUrl: string; allowIndependentMark?: boolean; assertLease?: () => void;
    makerSource: string; operatorSource: string },
  env: ReturnType<typeof loadEnv>,
  deployment: NonNullable<ReturnType<typeof loadDeploymentRegistry>>,
): Promise<boolean> {
  const position = candidate.makerPosition;
  const relayer = createRelayer({ config: {
    commandTimeoutMs: env.stellarCommandTimeoutMs, mode: "stellar-cli",
    network: env.stellarNetwork, networkPassphrase: env.stellarNetworkPassphrase,
    rpcUrl: env.stellarRpcUrl, source: input.operatorSource,
  } });
  const onchain = createOnchainRelay(relayer, { deployment, enabled: true });
  const prover = createProver();
  const service = new PositionClosesService(executor, prover, onchain, env);
  const context = service.context({ ownerCommitment: position.ownerCommitment,
    positionCommitment: position.positionCommitment }, candidate.allocation.maker);
  const markPrice = BigInt(context.market.markPrice);
  const clientMarkPrice = executor.store.positionCloses.get(candidate.clientPosition.closeCommitment!)?.markPrice;
  if (clientMarkPrice !== markPrice && !input.allowIndependentMark) {
    if (!warnedMarkMismatch.has(position.positionCommitment)) {
      console.error(`[vault-maker] maker close deferred for ${position.positionCommitment}: paired trader closed at a different mark`);
      warnedMarkMismatch.add(position.positionCommitment);
    }
    return false;
  }
  warnedMarkMismatch.delete(position.positionCommitment);
  const prepared = preparePairedMakerClose({
    fundingIndex: BigInt(context.market.fundingIndex),
    makerNote: candidate.makerNote, makerPosition: position, markPrice,
    prover, store: executor.store,
    traderCloseCommitment: candidate.clientPosition.closeCommitment!,
  });
  const { close: proven, note } = prepared;
  input.assertLease?.();
  const app: SmokeApp = { origin: input.apiUrl, handle: (request) => fetch(request) };
  const authHeaders = await authHeadersFor(app, input.makerSource, candidate.allocation.maker, env);
  await insertPendingMakerNote({
    ...note, shieldedPool: deployment.contracts["shielded-pool"],
    source: input.makerSource, token: env.collateralTokenContract!, updatedAt: Date.now(),
    walletAddress: candidate.allocation.maker,
    vaultAllocationId: candidate.allocation.id,
    vaultParentCommitment: candidate.makerNote.commitment,
  });
  const response = await fetch(`${input.apiUrl}/position-closes/manual-proven`, {
    method: "POST", headers: authHeaders,
    body: JSON.stringify(proven, (_key, value) => typeof value === "bigint" ? value.toString() : value),
  });
  if (!response.ok) throw new Error(`maker position close rejected (${response.status}): ${await response.text()}`);
  const body = await response.json() as { positionClose?: { settlementTxHash?: string;
    marginOutputCommitment?: Hex; closeCommitment?: Hex } };
  const txHash = body.positionClose?.settlementTxHash;
  if (!txHash || body.positionClose?.marginOutputCommitment !== note.commitment ||
    body.positionClose?.closeCommitment !== proven.closeCommitment) {
    throw new Error("maker position close response does not match the prepared output");
  }
  await assertSuccessfulTransaction(env.stellarRpcUrl, txHash);
  process.stdout.write(`${JSON.stringify({ positionCommitment: position.positionCommitment,
    outputCommitment: note.commitment, txHash, status: "maker-closed" })}\n`);
  return true;
}
