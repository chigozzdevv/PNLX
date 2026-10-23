import { createECDH, createHash } from "node:crypto";
import {
  digestToFieldHex,
  ownerCommitment,
  secureMarginCommitment,
  secureMarginNullifier,
  commitIntent,
} from "@pnlx/crypto";
import type {
  BatchSettlement,
  Hex,
  IntentRecord,
  IntentValidityRecord,
  PrivateMatchIntent,
  TradeIntent,
} from "@pnlx/protocol-types";
import {IntentsService} from "@/features/intents/intents.service";
import {
  claimMakerNote,
  readMakerNotes,
  saveMakerNotes,
  type StoredMakerNoteRecord,
} from "@/shared/maker-note-store";
import {
  eligibleVaultMakerNotes,
  readVaultMakerAllocations,
} from "@/shared/vault-maker-backing";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelay } from "@/workers/onchain/onchain.model";
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
  status: "pending" | "available" | "locked" | "draining" | "withdrawing" | "spent";
  walletAddress: string;
  lockedByIntentCommitment?: Hex;
  sourceIntentCommitment?: Hex;
  vaultAllocationId?: string;
  vaultParentCommitment?: Hex;
};

type MakerNoteAllocation = {
  margin: bigint;
  note: StoredMakerNote;
  size: bigint;
};

export function makerQuoteForIntent(payload: Pick<PrivateMatchIntent,"signedSize"|"limitPrice">,
  referencePrice: bigint, spreadBps=0n): bigint | undefined {
  if(referencePrice<=0n || spreadBps<0n || spreadBps>=10_000n)throw new Error("invalid maker price policy");
  const buys=payload.signedSize>0n;
  const quote=buys ? (referencePrice*(10_000n+spreadBps)+9_999n)/10_000n :
    referencePrice*(10_000n-spreadBps)/10_000n;
  if(quote<=0n || (buys ? payload.limitPrice<quote : payload.limitPrice>quote))return undefined;
  const deviation=payload.limitPrice>referencePrice ? payload.limitPrice-referencePrice : referencePrice-payload.limitPrice;
  if(deviation*10_000n>referencePrice*200n)return undefined;
  return quote;
}

export interface MakerLiquidityRunResult {
  created: number;
  skipped: number;
}

export class MakerLiquidityService {
  private readonly intents:IntentsService;
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain: OnchainRelay | undefined,
    private readonly env: Pick<ServerEnv, "intentRegistryOnchainRequired"> &
      Partial<Pick<ServerEnv, "makerWalletAddress">>,
    private readonly vaultBacking?: {
      asset: string;
      readDeployedPrincipal: () => Promise<bigint>;
      readSeriesPrincipal: (series: number) => Promise<bigint>;
      vault: string;
    },
    private readonly claimNote:typeof claimMakerNote=claimMakerNote,
  ) {this.intents=new IntentsService(executor,prover,onchain,env);}

  async ensureForMarket(input: {
    batchId: string;
    marketId: string;
  }): Promise<MakerLiquidityRunResult> {
    if (this.env.makerWalletAddress && input.marketId !== "xlm-usd-perp") {
      return { created: 0, skipped: 0 };
    }
    await this.intents.recoverPendingIntents();
    let notes = normalizeMakerNotes(await readMakerNotes());
    const knownIntents=new Map(this.executor.store.intents);
    for(const pending of this.executor.store.pendingIntentSubmissions.values())knownIntents.set(pending.intentCommitment,pending.prepared.record);
    const unlocked = unlockStaleMakerLocks(notes, knownIntents);
    if (unlocked.changed) {
      await saveMakerNotes(unlocked.notes.filter((note, index) => note !== notes[index]));
      notes = unlocked.notes;
    }
    const reaped = this.reapOrphanedMakerIntents(notes);
    if (reaped.changed) {
      await saveMakerNotes(reaped.notes.filter((note, index) => note !== notes[index]));
      notes = reaped.notes;
      await this.flushStore();
    }
    this.indexMakerMarginCommitments(notes);
    if (this.ensureMakerAccountKeys(notes)) {
      await this.flushStore();
    }
    const makerOwners = new Set(
      eligibleMakerNotes(notes, this.env.makerWalletAddress).map((note) => noteOwnerCommitment(note)),
    );
    const openClientIntents = [...this.executor.store.intents.values()]
      .filter((intent) => intent.marketId === input.marketId)
      .filter((intent) => !makerOwners.has(intent.ownerCommitment))
      .filter((intent) => this.executor.store.orderLifecycle.get(intent.intentCommitment)?.status === "open")
      .sort((left, right) => left.intentCommitment.localeCompare(right.intentCommitment));
    if (openClientIntents.length === 0) return { created: 0, skipped: 0 };
    const backing = this.env.makerWalletAddress
      ? await this.currentVaultBacking()
      : undefined;

    let created = 0;
    let skipped = 0;
    let currentNotes = notes;
    for (const clientIntent of openClientIntents) {
      created += await this.resumePendingMakerIntents(clientIntent,currentNotes,backing);
      if (hasLockedMakerForSource(currentNotes, clientIntent.intentCommitment)) {
        skipped += 1;
        continue;
      }
      const payload = this.executor.store.privateMatchIntents.get(clientIntent.intentCommitment);
      if (!payload) {
        skipped += 1;
        continue;
      }
      const market=this.executor.store.markets.get(input.marketId);
      const quote=market ? makerQuoteForIntent(payload,market.oraclePrice) : undefined;
      if(quote===undefined){skipped+=1;continue;}
      const makerNotes = this.env.makerWalletAddress
        ? eligibleVaultMakerNotes(currentNotes, backing!.allocations, {
            asset: backing!.asset,
            deployedPrincipal: backing!.deployedPrincipal,
            seriesPrincipals: backing!.seriesPrincipals,
            maker: this.env.makerWalletAddress.trim().toUpperCase(),
            vault: backing!.vault,
          })
        : eligibleMakerNotes(currentNotes.filter(note=>!note.vaultAllocationId));
      const allocations = selectMakerNoteAllocations(
        makerNotes.filter((note) => this.executor.store.marginCommitments.has(note.commitment)),
        payload,
      );
      if (allocations.length === 0) {
        skipped += 1;
        continue;
      }

      for (const allocation of allocations) {
        const record = await this.submitMakerIntent({
          batchId: makerBatchId(input.batchId, clientIntent.intentCommitment, allocation.note.commitment),
          clientIntent,
          margin: allocation.margin,
          note: allocation.note,
          payload,
          size: allocation.size,
          quotePrice: quote,
        });
        if (!record) {
          skipped += 1;
          continue;
        }
        await this.flushStore();
        currentNotes = lockMakerNote(
          currentNotes,
          allocation.note.commitment,
          record.intentCommitment,
          clientIntent.intentCommitment,
        );
        await saveMakerNotes(currentNotes.filter((note) => note.commitment === allocation.note.commitment));
        created += 1;
      }
    }

    return { created, skipped };
  }

  private async resumePendingMakerIntents(
    source:IntentRecord,
    notes:StoredMakerNote[],
    backing?:Awaited<ReturnType<MakerLiquidityService["currentVaultBacking"]>>,
  ):Promise<number> {
    const store=this.executor.store;
    if(store.orderLifecycle.get(source.intentCommitment)?.status!=="open")return 0;
    const payload=store.privateMatchIntents.get(source.intentCommitment);
    const market=store.markets.get(source.marketId);
    const quote=payload&&market?makerQuoteForIntent(payload,market.oraclePrice):undefined;
    if(quote===undefined)return 0;
    // Revalidate backing while retaining the exact already-proved order and private seed.
    const candidates=notes.map(note=>note.status==="locked"?{...note,status:"available" as const}:note);
    const eligible=this.env.makerWalletAddress
      ? backing?eligibleVaultMakerNotes(candidates,backing.allocations,{
          asset:backing.asset,deployedPrincipal:backing.deployedPrincipal,
          seriesPrincipals:backing.seriesPrincipals,maker:this.env.makerWalletAddress.trim().toUpperCase(),
          vault:backing.vault,
        }):[]
      :eligibleMakerNotes(candidates.filter(note=>!note.vaultAllocationId));
    const allowed=new Set(eligible.map(note=>note.commitment));
    let resumed=0;
    for(let index=0;index<notes.length;index++) {
      const note=notes[index]!;
      if(!allowed.has(note.commitment))continue;
      const expectedNonce=`${source.intentCommitment}:${note.commitment}:maker-nonce`;
      const pending=note.status==="locked"&&note.sourceIntentCommitment===source.intentCommitment&&
        note.lockedByIntentCommitment?store.pendingIntentSubmissions.get(note.lockedByIntentCommitment):
        note.status==="available"?[...store.pendingIntentSubmissions.values()].find(item=>
          item.validity.noteCommitment===note.commitment&&item.intent.nonce===expectedNonce):undefined;
      if(!pending)continue;
      const {intent,validity}=pending;
      const expectedSalt=`${source.intentCommitment}:${note.commitment}:maker-salt`;
      if(pending.replacementOf||pending.conditionalPolicy||intent.owner!==note.walletAddress||
        intent.marketId!==source.marketId||intent.nonce!==expectedNonce||intent.salt!==expectedSalt||
        intent.noteNullifier!==note.noteNullifier||validity.noteCommitment!==note.commitment||
        validity.assetDigest!==note.assetDigest||validity.ownerDigest!==note.ownerDigest||
        pending.prepared.record.ownerCommitment!==noteOwnerCommitment(note)||
        intent.margin<=0n||intent.margin>BigInt(note.amount)||intent.margin>payload!.margin||
        intent.size<=0n||intent.size>(payload!.signedSize<0n?-payload!.signedSize:payload!.signedSize)||
        intent.side!==(payload!.signedSize>=0n?"short":"long")||intent.limitPrice!==quote)continue;
      try {
        await this.intents.submitDurable({intent,validity},intent.owner,{beforeSubmit:async()=>{
          if(store.orderLifecycle.get(source.intentCommitment)?.status!=="open")throw new MakerNoteClaimUnavailable();
          if(!await this.claimNote(note.commitment,pending.intentCommitment,source.intentCommitment,
            note.vaultAllocationId))throw new MakerNoteClaimUnavailable();
        }});
        notes[index]={...note,status:"locked",lockedByIntentCommitment:pending.intentCommitment,
          sourceIntentCommitment:source.intentCommitment};
        resumed++;
      }catch(error){if(!(error instanceof MakerNoteClaimUnavailable))throw error;}
    }
    return resumed;
  }

  private async currentVaultBacking(): Promise<{
    allocations: Awaited<ReturnType<typeof readVaultMakerAllocations>>;
    asset: string;
    deployedPrincipal: bigint;
    seriesPrincipals: Map<number, bigint>;
    vault: string;
  }> {
    if (!this.vaultBacking) throw new Error("vault maker backing is not configured");
    const [allocations, deployedPrincipal] = await Promise.all([
      readVaultMakerAllocations(),
      this.vaultBacking.readDeployedPrincipal(),
    ]);
    const ids = [...new Set(allocations.filter((item) => item.status === "outstanding" &&
      Number.isSafeInteger(item.series) && item.series >= 0).map((item) => item.series))];
    const seriesPrincipals = new Map(await Promise.all(ids.map(async (series) =>
      [series, await this.vaultBacking!.readSeriesPrincipal(series)] as const)));
    return { allocations, asset: this.vaultBacking.asset,
      deployedPrincipal, seriesPrincipals, vault: this.vaultBacking.vault };
  }

  async finalizeSettlement(settlement: BatchSettlement): Promise<void> {
    const filled = new Set(
      settlement.orderUpdates
        .filter((update) => update.status === "filled" || update.status === "partially-filled")
        .map((update) => update.intentCommitment),
    );
    if (filled.size === 0) return;

    const notes = normalizeMakerNotes(await readMakerNotes());
    const next = finalizedMakerNotes(notes, filled, this.executor.store.privateMatchIntents);
    const previous = new Map(notes.map((note) => [note.commitment, note]));
    await saveMakerNotes(next.filter((note) => previous.get(note.commitment) !== note));
  }

  private async submitMakerIntent(input: {
    batchId: string;
    clientIntent: IntentRecord;
    margin: bigint;
    note: StoredMakerNote;
    payload: PrivateMatchIntent;
    size: bigint;
    quotePrice: bigint;
  }): Promise<IntentRecord | undefined> {
    const size = input.size;
    const side = input.payload.signedSize >= 0n ? "short" : "long";
    const noteAmount = BigInt(input.note.amount);
    if (noteAmount < input.margin) throw new Error("maker note allocation exceeds note amount");
    const change = buildMakerChangeNote(
      input.note,
      input.margin,
      input.clientIntent.intentCommitment,
    );
    if (this.onchain?.enabled && this.env.intentRegistryOnchainRequired) {
      if (!this.onchain.secureNoteSnapshot) throw new Error("secure note reader unavailable");
      const snapshot = this.onchain.secureNoteSnapshot(
        [...this.executor.store.marginCommitments]);
      if (snapshot.root !== this.executor.store.marginMembershipRoot()) {
        this.executor.store.replaceMarginCommitments(snapshot.commitments);
      }
    }
    const membershipProof = this.executor.store.marginMembershipProof(input.note.commitment);
    const intent: TradeIntent = {
      batchId: input.batchId,
      limitPrice: input.quotePrice,
      margin: input.margin,
      marketId: input.clientIntent.marketId,
      nonce: `${input.clientIntent.intentCommitment}:${input.note.commitment}:maker-nonce`,
      noteNullifier: input.note.noteNullifier,
      owner: input.note.walletAddress,
      salt: `${input.clientIntent.intentCommitment}:${input.note.commitment}:maker-salt`,
      side,
      size,
    };
    const intentCommitment=commitIntent(intent);
    const local=this.executor.store.intents.get(intentCommitment);
    if(local) {
      return this.executor.store.orderLifecycle.get(intentCommitment)?.status==="open"?local:undefined;
    }
    const pending=this.executor.store.pendingIntentSubmissions.get(intentCommitment);
    const validity = pending?.validity ?? await this.prover.proveIntentValidityAsync({
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

    try {
      return await this.intents.submitDurable({intent,validity},intent.owner,{beforeSubmit:async()=>{
        if(!await this.claimNote(input.note.commitment,validity.intentCommitment,
          input.clientIntent.intentCommitment,input.note.vaultAllocationId))throw new MakerNoteClaimUnavailable();
      }});
    } catch (error) {
      if(error instanceof MakerNoteClaimUnavailable)return undefined;
      throw error;
    }
  }

  private reapOrphanedMakerIntents(notes: StoredMakerNote[]): { changed: boolean; notes: StoredMakerNote[] } {
    let changed = false;
    const next = notes.map((note) => {
      if (note.status !== "locked" || !note.lockedByIntentCommitment || !note.sourceIntentCommitment) {
        return note;
      }
      if(this.executor.store.pendingIntentSubmissions.has(note.lockedByIntentCommitment))return note;
      if (this.executor.store.orderLifecycle.get(note.sourceIntentCommitment)?.status === "open") {
        return note;
      }
      const makerOrder = this.executor.store.orderLifecycle.get(note.lockedByIntentCommitment);
      if (makerOrder?.status === "filled") return note;
      if (makerOrder && makerOrder.status !== "cancelled") {
        this.executor.store.cancelOrder(note.lockedByIntentCommitment);
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

  private indexMakerMarginCommitments(notes: StoredMakerNote[]): void {
    for (const note of notes) {
      if (note.status === "spent" || note.status === "pending") continue;
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

class MakerNoteClaimUnavailable extends Error {
  constructor(){super("maker note is reserved by another intent");}
}

export function finalizedMakerNotes(
  notes: StoredMakerNote[], filled: Set<Hex>, payloads: ReadonlyMap<Hex, PrivateMatchIntent>,
): StoredMakerNote[] {
  const existing = new Set(notes.map((note) => note.commitment));
  const next: StoredMakerNote[] = [];
  for (const note of notes) {
    if (!note.lockedByIntentCommitment || !filled.has(note.lockedByIntentCommitment)) {
      next.push(note);
      continue;
    }
    next.push(note.status === "spent" ? note : { ...note, status: "spent", updatedAt: Date.now() });
    const payload = payloads.get(note.lockedByIntentCommitment);
    if (!payload || !note.sourceIntentCommitment) continue;
    const change = buildMakerChangeNote(note, payload.margin, note.sourceIntentCommitment);
    if (change && !existing.has(change.commitment)) {
      next.push(change);
      existing.add(change.commitment);
    }
  }
  return next;
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

export function eligibleMakerNotes<T extends { walletAddress: string }>(
  notes: T[],
  walletAddress?: string,
): T[] {
  if (!walletAddress) return notes;
  const expected = walletAddress.trim().toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(expected)) throw new Error("invalid maker wallet address");
  return notes.filter((note) => note.walletAddress.trim().toUpperCase() === expected);
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
  const spendSecretDigest = note.spendSecretDigest as Hex;
  const commitment = secureMarginCommitment({
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
    noteNullifier: secureMarginNullifier({ rhoDigest, spendSecretDigest }),
    ownerCommitment: noteOwnerCommitment(note),
    ownerDigest: note.ownerDigest,
    rhoDigest,
    source: "maker-change",
    spendSecretDigest,
    status: "available",
    ...(note.token ? { token: note.token } : {}),
    ...(note.shieldedPool ? { shieldedPool: note.shieldedPool } : {}),
    updatedAt: Date.now(),
    ...(note.vaultAllocationId
      ? { vaultAllocationId: note.vaultAllocationId, vaultParentCommitment: note.commitment }
      : {}),
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
      note.vaultAllocationId ||
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
