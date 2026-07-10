import { createECDH, createHash } from "node:crypto";
import {
  circuitMarginCommitment,
  circuitNullifier,
  digestToFieldHex,
  ownerCommitment,
} from "@pnlx/crypto";
import type {
  BatchSettlement,
  Hex,
  IntentRecord,
  IntentValidityRecord,
  PrivateMatchIntent,
  TradeIntent,
} from "@pnlx/protocol-types";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import {
  readMakerNotes,
  saveMakerNotes,
  type StoredMakerNoteRecord,
} from "@/shared/maker-note-store";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelay, OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { ProverService } from "@/workers/prover/prover.service";

const ZERO_HEX = "0x0" as Hex;
const MAKER_BATCH_PREFIX = "maker-auto";

type StoredMakerNote = StoredMakerNoteRecord & {
  amount: string;
  assetDigest: Hex;
  blinding: Hex;
  commitment: Hex;
  noteNullifier: Hex;
  ownerCommitment?: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  spendSecretDigest: Hex;
  status: "available" | "locked" | "spent";
  walletAddress: string;
  lockedByIntentCommitment?: Hex;
  sourceIntentCommitment?: Hex;
};

type MakerNoteAllocation = {
  margin: bigint;
  note: StoredMakerNote;
  size: bigint;
};

export interface MakerLiquidityRunResult {
  created: number;
  skipped: number;
}

export class MakerLiquidityService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain: OnchainRelay | undefined,
    private readonly env: Pick<ServerEnv, "intentRegistryOnchainRequired">,
  ) {}

  async ensureForMarket(input: {
    batchId: string;
    marketId: string;
  }): Promise<MakerLiquidityRunResult> {
    let notes = normalizeMakerNotes(await readMakerNotes());
    const unlocked = unlockStaleMakerLocks(notes, this.executor.store.intents);
    if (unlocked.changed) {
      notes = unlocked.notes;
      await saveMakerNotes(notes);
    }
    this.indexMakerMarginCommitments(notes);
    if (this.ensureMakerAccountKeys(notes)) {
      await this.flushStore();
    }
    const makerOwners = new Set(notes.map((note) => noteOwnerCommitment(note)));
    const openClientIntents = [...this.executor.store.intents.values()]
      .filter((intent) => intent.marketId === input.marketId)
      .filter((intent) => !makerOwners.has(intent.ownerCommitment))
      .filter((intent) => this.executor.store.orderLifecycle.get(intent.intentCommitment)?.status === "open")
      .sort((left, right) => left.intentCommitment.localeCompare(right.intentCommitment));

    let created = 0;
    let skipped = 0;
    let currentNotes = notes;
    for (const clientIntent of openClientIntents) {
      if (hasLockedMakerForSource(currentNotes, clientIntent.intentCommitment)) {
        skipped += 1;
        continue;
      }
      const payload = this.executor.store.privateMatchIntents.get(clientIntent.intentCommitment);
      if (!payload) {
        skipped += 1;
        continue;
      }
      const allocations = selectMakerNoteAllocations(currentNotes, payload);
      if (allocations.length === 0) {
        skipped += 1;
        continue;
      }

      for (const allocation of allocations) {
        const record = this.submitMakerIntent({
          batchId: makerBatchId(input.batchId, clientIntent.intentCommitment, allocation.note.commitment),
          clientIntent,
          margin: allocation.margin,
          note: allocation.note,
          payload,
          size: allocation.size,
        });
        await this.flushStore();
        currentNotes = lockMakerNote(
          currentNotes,
          allocation.note.commitment,
          record.intentCommitment,
          clientIntent.intentCommitment,
        );
        await saveMakerNotes(currentNotes);
        created += 1;
      }
    }

    return { created, skipped };
  }

  async finalizeSettlement(settlement: BatchSettlement): Promise<void> {
    const filled = new Set(
      settlement.orderUpdates
        .filter((update) => update.status === "filled" || update.status === "partially-filled")
        .map((update) => update.intentCommitment),
    );
    if (filled.size === 0) return;

    const notes = normalizeMakerNotes(await readMakerNotes());
    const next: StoredMakerNote[] = [];
    for (const note of notes) {
      if (!note.lockedByIntentCommitment || !filled.has(note.lockedByIntentCommitment)) {
        next.push(note);
        continue;
      }

      next.push({
        ...note,
        status: "spent",
        updatedAt: Date.now(),
      });
      const makerPayload = this.executor.store.privateMatchIntents.get(
        note.lockedByIntentCommitment,
      );
      if (!makerPayload || !note.sourceIntentCommitment) continue;
      const change = buildMakerChangeNote(
        note,
        makerPayload.margin,
        note.sourceIntentCommitment,
      );
      if (change && !next.some((candidate) => candidate.commitment === change.commitment)) {
        next.push(change);
      }
    }
    await saveMakerNotes(next);
  }

  private submitMakerIntent(input: {
    batchId: string;
    clientIntent: IntentRecord;
    margin: bigint;
    note: StoredMakerNote;
    payload: PrivateMatchIntent;
    size: bigint;
  }): IntentRecord {
    const size = input.size;
    const side = input.payload.signedSize >= 0n ? "short" : "long";
    const noteAmount = BigInt(input.note.amount);
    if (noteAmount < input.margin) throw new Error("maker note allocation exceeds note amount");
    const change = buildMakerChangeNote(
      input.note,
      input.margin,
      input.clientIntent.intentCommitment,
    );
    const membershipProof = this.executor.store.marginMembershipProof(input.note.commitment);
    const intent: TradeIntent = {
      batchId: input.batchId,
      limitPrice: input.payload.limitPrice,
      margin: input.margin,
      marketId: input.clientIntent.marketId,
      nonce: `${input.clientIntent.intentCommitment}:${input.note.commitment}:maker-nonce`,
      noteNullifier: input.note.noteNullifier,
      owner: input.note.walletAddress,
      salt: `${input.clientIntent.intentCommitment}:${input.note.commitment}:maker-salt`,
      side,
      size,
    };
    const validity = this.prover.proveIntentValidity({
      intent,
      assetDigest: input.note.assetDigest,
      blinding: input.note.blinding,
      changeBlinding: change?.blinding ?? ZERO_HEX,
      changeRhoDigest: change?.rhoDigest ?? ZERO_HEX,
      currentBatch: 1n,
      expiryBatch: 2n,
      marginRoot: membershipProof.root,
      noteAmount,
      noteChangeCommitment: change?.commitment ?? ZERO_HEX,
      noteCommitment: input.note.commitment,
      ownerDigest: input.note.ownerDigest,
      pathIndices: membershipProof.indices,
      pathSiblings: membershipProof.siblings,
      rhoDigest: input.note.rhoDigest,
      spendSecretDigest: input.note.spendSecretDigest,
    }) as IntentValidityRecord;

    this.executor.store.recordProof(validity.proof);
    const prepared = this.executor.prepareIntent({ intent, validity });
    const { alreadyRegistered, relay } = this.submitIntentOnchain(prepared.record);
    if (this.env.intentRegistryOnchainRequired) {
      if (!this.onchain?.enabled) throw new Error("intent registry requires on-chain relay");
      if (!alreadyRegistered) assertSubmittedRelay(relay, "submit");
    }
    return this.executor.commitPreparedIntent(prepared);
  }

  private submitIntentOnchain(record: IntentRecord): {
    alreadyRegistered: boolean;
    relay?: OnchainRelayResult;
  } {
    try {
      return {
        alreadyRegistered: false,
        relay: this.onchain?.submitIntent(record),
      };
    } catch (error) {
      if (this.onchain?.isIntentRegistered?.(record.intentCommitment)) {
        return { alreadyRegistered: true };
      }
      throw error;
    }
  }

  private indexMakerMarginCommitments(notes: StoredMakerNote[]): void {
    for (const note of notes) {
      if (note.status === "spent") continue;
      if (this.executor.store.marginCommitments.has(note.commitment)) continue;
      this.executor.store.addMarginCommitment(note.commitment);
    }
  }

  private ensureMakerAccountKeys(notes: StoredMakerNote[]): boolean {
    const now = Date.now();
    const seen = new Set<Hex>();
    let changed = false;

    for (const note of notes) {
      const owner = noteOwnerCommitment(note);
      if (seen.has(owner) || this.executor.store.accountEncryptionKey(owner)) continue;
      seen.add(owner);
      this.executor.store.upsertAccountEncryptionKey({
        algorithm: "ecdh-p256-aes-gcm",
        createdAt: now,
        ownerCommitment: owner,
        publicKey: deterministicMakerAccountPublicKey(note.walletAddress),
        updatedAt: now,
      });
      changed = true;
    }

    return changed;
  }

  private async flushStore(): Promise<void> {
    const store = this.executor.store as unknown;
    if (store && typeof store === "object" && "flush" in store && typeof store.flush === "function") {
      await (store as { flush(): Promise<void> }).flush();
    }
  }
}

function normalizeMakerNotes(notes: StoredMakerNoteRecord[]): StoredMakerNote[] {
  return notes
    .map((note) => note as StoredMakerNote)
    .filter((note) =>
      Boolean(
        note.amount &&
          note.assetDigest &&
          note.blinding &&
          note.commitment &&
          note.noteNullifier &&
          note.ownerDigest &&
          note.rhoDigest &&
          note.spendSecretDigest &&
          note.status &&
          note.walletAddress,
      )
    );
}

function noteOwnerCommitment(note: StoredMakerNote): Hex {
  return note.ownerCommitment ?? ownerCommitment(note.walletAddress);
}

export function selectMakerNoteAllocations(
  notes: StoredMakerNote[],
  payload: PrivateMatchIntent,
): MakerNoteAllocation[] {
  const requiredMargin = payload.margin;
  const totalSize = payload.signedSize >= 0n ? payload.signedSize : -payload.signedSize;
  if (requiredMargin <= 0n || totalSize <= 0n) return [];

  const candidates = notes
    .filter((note) => note.status === "available")
    .map((note) => ({ amount: BigInt(note.amount), note }))
    .filter((candidate) => candidate.amount > 0n)
    .sort(compareMakerNoteCandidate);

  const exact = candidates.find((candidate) => candidate.amount === requiredMargin);
  if (exact) {
    return [{
      margin: exact.amount,
      note: exact.note,
      size: totalSize,
    }];
  }

  // Pick the smallest note that can cover the required margin fully
  const largerNotes = candidates
    .filter((c) => c.amount >= requiredMargin)
    .sort((a, b) => (a.amount < b.amount ? -1 : 1));
  const bestLarger = largerNotes[0];
  if (bestLarger) {
    return [{
      margin: requiredMargin,
      note: bestLarger.note,
      size: totalSize,
    }];
  }

  // Fallback: combine smaller notes and spend only the required amount from the final note.
  let remainingMargin = requiredMargin;
  const selected: Array<{ margin: bigint; note: StoredMakerNote }> = [];
  const smallerCandidates = candidates
    .filter((c) => c.amount < requiredMargin)
    .sort((a, b) => (a.amount > b.amount ? -1 : 1));
  for (const candidate of smallerCandidates) {
    const margin = candidate.amount < remainingMargin ? candidate.amount : remainingMargin;
    if (margin <= 0n) continue;
    selected.push({ margin, note: candidate.note });
    remainingMargin -= margin;
    if (remainingMargin === 0n) break;
  }
  if (remainingMargin !== 0n) return [];

  let remainingSize = totalSize;
  return selected.map((candidate, index) => {
    const isLast = index === selected.length - 1;
    const size = isLast
      ? remainingSize
      : (totalSize * candidate.margin) / requiredMargin;
    remainingSize -= size;
    return {
      margin: candidate.margin,
      note: candidate.note,
      size,
    };
  }).filter((allocation) => allocation.size > 0n);
}

export function buildMakerChangeNote(
  note: StoredMakerNote,
  margin: bigint,
  sourceIntentCommitment: Hex,
): StoredMakerNote | undefined {
  const amount = BigInt(note.amount) - margin;
  if (amount < 0n) throw new Error("maker note change exceeds note amount");
  if (amount === 0n) return undefined;

  const scope = [
    sourceIntentCommitment,
    note.commitment,
    note.rhoDigest,
    note.blinding,
    note.spendSecretDigest,
  ].join(":");
  const rhoDigest = digestToFieldHex(`maker-change-rho-v1:${scope}`);
  const blinding = digestToFieldHex(`maker-change-blinding-v1:${scope}`);
  const spendSecretDigest = digestToFieldHex(`maker-change-spend-v1:${scope}`);
  const commitment = circuitMarginCommitment({
    amount,
    assetDigest: note.assetDigest,
    blinding,
    ownerDigest: note.ownerDigest,
    rhoDigest,
    spendSecretDigest,
  });

  return {
    amount: amount.toString(),
    assetDigest: note.assetDigest,
    blinding,
    commitment,
    createdAt: Date.now(),
    noteNullifier: circuitNullifier({ rhoDigest, spendSecretDigest }),
    ownerCommitment: noteOwnerCommitment(note),
    ownerDigest: note.ownerDigest,
    rhoDigest,
    source: "maker-change",
    spendSecretDigest,
    status: "available",
    updatedAt: Date.now(),
    walletAddress: note.walletAddress,
  };
}

function compareMakerNoteCandidate(
  left: { amount: bigint; note: StoredMakerNote },
  right: { amount: bigint; note: StoredMakerNote },
): number {
  if (left.amount !== right.amount) return left.amount > right.amount ? -1 : 1;
  return left.note.commitment.localeCompare(right.note.commitment);
}

function hasLockedMakerForSource(notes: StoredMakerNote[], sourceIntentCommitment: Hex): boolean {
  return notes.some(
    (note) =>
      note.status === "locked" &&
      note.sourceIntentCommitment === sourceIntentCommitment &&
      Boolean(note.lockedByIntentCommitment),
  );
}

function lockMakerNote(
  notes: StoredMakerNote[],
  commitment: Hex,
  intentCommitment: Hex,
  sourceIntentCommitment: Hex,
): StoredMakerNote[] {
  return notes.map((note) =>
    note.commitment === commitment
      ? {
          ...note,
          lockedByIntentCommitment: intentCommitment,
          sourceIntentCommitment,
          status: "locked",
          updatedAt: Date.now(),
        }
      : note,
  );
}

function unlockStaleMakerLocks(
  notes: StoredMakerNote[],
  intents: Map<string, IntentRecord>,
): { changed: boolean; notes: StoredMakerNote[] } {
  let changed = false;
  const next = notes.map((note) => {
    if (
      note.status !== "locked" ||
      !note.lockedByIntentCommitment ||
      intents.has(note.lockedByIntentCommitment)
    ) {
      return note;
    }
    changed = true;
    return {
      ...note,
      lockedByIntentCommitment: undefined,
      sourceIntentCommitment: undefined,
      status: "available" as const,
      updatedAt: Date.now(),
    };
  });
  return { changed, notes: next };
}

function makerBatchId(batchId: string, sourceIntentCommitment: Hex, noteCommitment: Hex): string {
  return `${MAKER_BATCH_PREFIX}-${batchId}-${sourceIntentCommitment.slice(2, 14)}-${noteCommitment.slice(2, 10)}`;
}

function deterministicMakerAccountPublicKey(walletAddress: string): string {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const privateKey = createHash("sha256")
      .update("pnlx-maker-account-encryption-key-v1")
      .update(walletAddress)
      .update(String(attempt))
      .digest();
    const ecdh = createECDH("prime256v1");
    try {
      ecdh.setPrivateKey(privateKey);
      return ecdh.getPublicKey().toString("base64url");
    } catch {
      // Try the next deterministic scalar if this digest is outside the P-256 range.
    }
  }
  throw new Error("maker account encryption key could not be derived");
}
