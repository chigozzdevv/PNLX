import type {
  AccountEventRecord,
  AccountEncryptionKeyRecord,
  BatchExecutionRunRecord,
  BatchSettlement,
  ConditionalOrderCommitment,
  ConditionalOrderRecord,
  DisclosureRecord,
  FundingUpdateRecord,
  FundingCycleRecord,
  FundingCycleCursor,
  FundingPremiumSampleRecord,
  Hex,
  IntentRecord,
  LiquidationAutomationJobRecord,
  LiquidationRecord,
  MarketConfig,
  OrderLifecycleRecord,
  PendingAssetDepositRecord,
  PositionCloseRecord,
  PositionLifecycleRecord,
  PrivateMatchIntent,
  ProofMeta,
  ResidualOrderRecord,
  WithdrawalRecord,
} from "@pnlx/protocol-types";
import {
  EMPTY_ROOT,
  FIELD_PRIME,
  merkleRoot,
  positionMerkleProof,
  positionMerkleRoot,
  secureMarginProof,
  secureMarginRoot,
} from "@pnlx/crypto";
import { assertPrivateMatchIntent } from "@/workers/batch-matcher/private-intent";
import {
  assertIdenticalDelegatedConditionalPolicy,
  createDelegatedConditionalPolicy,
  type DelegatedConditionalPolicy,
} from "@/shared/protocol/delegated-policies";
import type { PendingPairedClose } from "@/shared/protocol/paired-close-journal";
import { assertIdenticalIntentSubmission, copyIntentSubmission, type PendingIntentSubmission } from "@/shared/protocol/intent-submission-journal";

export const BATCH_EXECUTION_RUN_RETENTION = 1_000;
export const FUNDING_PREMIUM_SAMPLE_RETENTION = 120;

export interface MarketSettlementVolumeRecord {
  marketId: string;
  matchedVolume: bigint;
  settledAt: number;
  settlementDigest: Hex;
}

export class ProtocolStore {
  readonly marginCommitments = new Set<Hex>();
  readonly positionCommitments = new Set<Hex>();
  readonly spentNullifiers = new Set<Hex>();
  readonly intents = new Map<string, IntentRecord>();
  readonly residualOrders = new Map<Hex, ResidualOrderRecord>();
  readonly delegatedPolicies = new Map<Hex, DelegatedConditionalPolicy>();
  readonly pendingPairedCloses = new Map<Hex, PendingPairedClose>();
  readonly pendingIntentSubmissions = new Map<Hex, PendingIntentSubmission>();
  readonly orderLifecycle = new Map<Hex, OrderLifecycleRecord>();
  readonly positionLifecycle = new Map<Hex, PositionLifecycleRecord>();
  readonly markets = new Map<string, MarketConfig>();
  readonly settlements = new Map<string, BatchSettlement>();
  readonly marketSettlementVolumes = new Map<Hex, MarketSettlementVolumeRecord>();
  readonly liquidations = new Map<Hex, LiquidationRecord>();
  readonly conditionalOrders = new Map<Hex, ConditionalOrderCommitment>();
  readonly conditionalCloses = new Map<Hex, ConditionalOrderRecord>();
  readonly positionCloses = new Map<Hex, PositionCloseRecord>();
  readonly disclosures = new Map<Hex, DisclosureRecord>();
  readonly fundingUpdates = new Map<string, FundingUpdateRecord>();
  readonly fundingCycles = new Map<Hex, FundingCycleRecord>();
  readonly fundingCursors = new Map<string, FundingCycleCursor>();
  readonly fundingPremiumSamples = new Map<string, FundingPremiumSampleRecord>();
  readonly liquidationAutomationJobs = new Map<Hex, LiquidationAutomationJobRecord>();
  readonly batchExecutionRuns = new Map<Hex, BatchExecutionRunRecord>();
  readonly withdrawals = new Map<Hex, WithdrawalRecord>();
  readonly accountEvents = new Map<Hex, AccountEventRecord>();
  readonly accountEncryptionKeys = new Map<Hex, AccountEncryptionKeyRecord>();
  readonly pendingAssetDeposits = new Map<Hex, PendingAssetDepositRecord>();
  readonly privateMatchIntents = new Map<Hex, PrivateMatchIntent>();
  readonly proofs = new Set<string>();

  addPendingIntentSubmission(record: PendingIntentSubmission): void {
    if (record.intentCommitment !== record.prepared.record.intentCommitment ||
        record.validity.intentCommitment !== record.intentCommitment) throw new Error("prepared intent journal key mismatch");
    assertPrivateMatchIntent(record.prepared.record, record.prepared.privateMatchIntent);
    const previous = this.pendingIntentSubmissions.get(record.intentCommitment);
    if (previous) { assertIdenticalIntentSubmission(previous, record); return; }
    this.pendingIntentSubmissions.set(record.intentCommitment, copyIntentSubmission(record));
  }

  removePendingIntentSubmission(intentCommitment: Hex): void {
    this.pendingIntentSubmissions.delete(intentCommitment);
  }

  addDelegatedConditionalPolicy(record: DelegatedConditionalPolicy): void {
    const { createdAt: _createdAt, intentCommitment: _intent, marketId: _market, ownerCommitment: _owner, ...input } = record;
    const validated = createDelegatedConditionalPolicy(input, record)!;
    const existing = this.delegatedPolicies.get(validated.intentCommitment);
    if (existing) {
      assertIdenticalDelegatedConditionalPolicy(existing, validated);
      return;
    }
    this.delegatedPolicies.set(validated.intentCommitment, validated);
  }

  addPendingPairedClose(record: PendingPairedClose): void {
    const key = record.journalKey.toLowerCase() as Hex;
    if (key !== record.pair.positions[0].closeCommitment.toLowerCase()) throw new Error("paired close journal key mismatch");
    const existing = this.pendingPairedCloses.get(key);
    if (existing) {
      const payload = (value: PendingPairedClose) => JSON.stringify({
        conditional: value.conditional, outputNotes: value.outputNotes, pair: value.pair,
      }, (_key, item) => typeof item === "bigint" ? item.toString() : item);
      if (payload(existing) !== payload(record)) throw new Error("conflicting paired close journal");
      return;
    }
    this.pendingPairedCloses.set(key, { ...record, journalKey: key });
  }

  removePendingPairedClose(journalKey: Hex): void {
    this.pendingPairedCloses.delete(journalKey.toLowerCase() as Hex);
  }

  updatePendingPairedClose(record: PendingPairedClose): void {
    if(!this.pendingPairedCloses.has(record.journalKey))throw new Error("paired journal not found");
    this.addPendingPairedClose(record);
    this.pendingPairedCloses.set(record.journalKey,{...record});
  }

  marginRoot(): Hex {
    return this.marginCommitments.size === 0
      ? EMPTY_ROOT
      : merkleRoot([...this.marginCommitments]);
  }

  marginMembershipRoot(): Hex {
    return secureMarginRoot([...this.marginCommitments]);
  }

  marginMembershipProof(commitment: Hex) {
    return secureMarginProof([...this.marginCommitments], commitment);
  }

  replaceMarginCommitments(commitments: Hex[]): void {
    if (new Set(commitments).size !== commitments.length) {
      throw new Error("duplicate secure margin commitment");
    }
    this.marginCommitments.clear();
    for (const commitment of commitments) this.marginCommitments.add(commitment);
  }

  positionRoot(): Hex {
    return this.positionCommitments.size === 0
      ? EMPTY_ROOT
      : merkleRoot([...this.positionCommitments]);
  }

  positionMembershipRoot(): Hex {
    return positionMerkleRoot([...this.positionCommitments]);
  }

  positionMembershipProof(commitment: Hex) {
    return positionMerkleProof([...this.positionCommitments], commitment);
  }

  positionMembershipRootWith(commitment: Hex): Hex {
    return positionMerkleRoot([...this.positionCommitments, commitment]);
  }

  positionMembershipRootWithMany(commitments: Hex[]): Hex {
    return positionMerkleRoot([...this.positionCommitments, ...commitments]);
  }

  hasPositionMembershipRoot(root: Hex): boolean {
    const commitments = [...this.positionCommitments];
    for (let count = 0; count <= commitments.length; count += 1) {
      if (positionMerkleRoot(commitments.slice(0, count)) === root) return true;
    }
    return false;
  }

  addMarginCommitment(commitment: Hex): void {
    if (this.marginCommitments.has(commitment)) {
      throw new Error("margin commitment already exists");
    }
    this.marginCommitments.add(commitment);
  }

  addPendingAssetDeposit(record: PendingAssetDepositRecord): void {
    if (this.marginCommitments.has(record.commitment)) {
      throw new Error("asset deposit already credited");
    }
    if (this.pendingAssetDeposits.has(record.commitment)) {
      throw new Error("asset deposit already pending");
    }
    this.pendingAssetDeposits.set(record.commitment, record);
  }

  finalizePendingAssetDeposit(
    commitment: Hex,
    relay: { relayId: Hex; txHash?: Hex },
  ): PendingAssetDepositRecord {
    const pending = this.pendingAssetDeposits.get(commitment);
    if (!pending) throw new Error("pending asset deposit not found");
    if (pending.finalizedAt) throw new Error("asset deposit already finalized");
    const finalized = {
      ...pending,
      finalizedAt: Date.now(),
      relayId: relay.relayId,
      txHash: relay.txHash,
    };
    this.pendingAssetDeposits.set(commitment, finalized);
    return finalized;
  }

  confirmPendingAssetDeposit(
    commitment: Hex,
    confirmation: NonNullable<PendingAssetDepositRecord["confirmedRecovery"]>,
    commitments: Hex[],
  ): PendingAssetDepositRecord {
    const pending = this.pendingAssetDeposits.get(commitment);
    if (!pending || !pending.preparedTxHash || pending.preparedTxHash !== confirmation.txHash) {
      throw new Error("confirmed deposit does not match the durable prepared transaction");
    }
    if (!Number.isSafeInteger(confirmation.ledger) || confirmation.ledger <= 0 ||
        !Number.isSafeInteger(confirmation.observedAt) || confirmation.observedAt <= 0 ||
        !confirmation.network || !/^0x[0-9a-f]{64}$/i.test(confirmation.networkPassphraseHash)) {
      throw new Error("invalid confirmed deposit receipt");
    }
    const previous = pending.confirmedRecovery;
    if ((pending.txHash && pending.txHash !== confirmation.txHash) || (previous &&
        (previous.txHash !== confirmation.txHash || previous.ledger !== confirmation.ledger ||
         previous.network !== confirmation.network || previous.networkPassphraseHash !== confirmation.networkPassphraseHash))) {
      throw new Error("confirmed deposit receipt conflicts with existing finalization");
    }
    if (new Set(commitments).size !== commitments.length || !commitments.includes(commitment) ||
        [...this.marginCommitments].some((value, index) => commitments[index] !== value)) {
      throw new Error("confirmed secure note snapshot does not extend local membership");
    }
    if (previous && pending.finalizedAt) return pending;
    this.replaceMarginCommitments(commitments);
    this.recordProof(pending.depositProof.proof);
    const finalized = { ...pending, finalizedAt: pending.finalizedAt ?? Date.now(),
      txHash: confirmation.txHash, confirmedRecovery: { ...confirmation } };
    this.pendingAssetDeposits.set(commitment, finalized);
    return finalized;
  }

  addMarket(market: MarketConfig): void {
    if (this.markets.has(market.marketId)) throw new Error("market already exists");
    this.markets.set(market.marketId, market);
  }

  updateMarket(market: MarketConfig): void {
    if (!this.markets.has(market.marketId)) throw new Error("unknown market");
    this.markets.set(market.marketId, market);
  }

  addFundingUpdate(record: FundingUpdateRecord): void {
    const key = `${record.marketId}:${record.appliedAt}:${record.newFundingIndex}`;
    if (this.fundingUpdates.has(key)) throw new Error("funding update already exists");
    this.fundingUpdates.set(key, record);
  }

  upsertFundingCycle(record: FundingCycleRecord): void {
    assertFundingCycle(record);
    const previous = this.fundingCycles.get(record.cycleId);
    if (previous) {
      const identity = (value: FundingCycleRecord) => JSON.stringify({ ...value, status: undefined,
        reason: undefined, updatedAt: undefined, submissionAttempted: undefined, settlement: undefined,
        preparedXdr: undefined, settlementTxHash: undefined }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
      if (identity(previous) !== identity(record)) throw new Error("funding cycle identity changed");
      if (previous.submissionAttempted && (!record.submissionAttempted || record.status === "skipped" || record.status === "retired")) {
        throw new Error("attempted funding cycle requires exact reconciliation");
      }
      if ((previous.status === "settled" || previous.status === "skipped" || previous.status === "retired") &&
          previous.status !== record.status) throw new Error("funding cycle is already complete");
      if ((previous.settlementTxHash && previous.settlementTxHash !== record.settlementTxHash) ||
          (previous.preparedXdr && previous.preparedXdr !== record.preparedXdr)) throw new Error("funding transaction identity changed");
      if (previous.settlement && record.settlement && previous.settlement.proof.publicInputHash !== record.settlement.proof.publicInputHash) {
        throw new Error("funding proof identity changed");
      }
    }
    this.fundingCycles.set(record.cycleId, structuredClone(record));
  }

  /** Skip/zero decisions and their cursor are one checkpoint, with no cash transition. */
  skipFundingCycle(record: FundingCycleRecord): void {
    if (record.status !== "skipped" || record.oldFundingIndex !== record.newFundingIndex || record.submissionAttempted) {
      throw new Error("invalid skipped funding cycle");
    }
    const cursor = this.fundingCursors.get(record.marketId);
    if (cursor && cursor.windowEnd > record.windowEnd) throw new Error("funding cursor cannot move backwards");
    this.upsertFundingCycle(record);
    this.fundingCursors.set(record.marketId, { marketId: record.marketId, windowEnd: record.windowEnd, updatedAt: record.updatedAt });
  }

  /** Called only after exact chain confirmation (or explicit local development settlement). */
  finalizeFundingCycle(cycleId: Hex): FundingUpdateRecord {
    const record = this.fundingCycles.get(cycleId);
    if (!record || !record.settlement || record.premiumRate === null || record.oldFundingIndex === record.newFundingIndex) {
      throw new Error("funding settlement journal is incomplete");
    }
    const market = this.markets.get(record.marketId);
    const key = `${record.marketId}:${record.windowEnd}:${record.newFundingIndex}`;
    const existing = this.fundingUpdates.get(key);
    if (!market || (market.fundingIndex !== record.oldFundingIndex && market.fundingIndex !== record.newFundingIndex)) {
      throw new Error("funding settlement index requires reconciliation");
    }
    if (existing && (existing.oldFundingIndex !== record.oldFundingIndex || existing.newFundingIndex !== record.newFundingIndex)) {
      throw new Error("conflicting funding settlement history");
    }
    const cursor = this.fundingCursors.get(record.marketId);
    if (cursor && cursor.windowEnd > record.windowEnd) throw new Error("funding cursor is ahead of this settlement");
    const update: FundingUpdateRecord = { ...record.settlement, appliedAt: record.windowEnd,
      fundingDelta: record.newFundingIndex - record.oldFundingIndex };
    this.markets.set(record.marketId, { ...market, fundingIndex: record.newFundingIndex });
    this.fundingUpdates.set(key, update);
    this.fundingCycles.set(cycleId, { ...record, status: "settled", reason: undefined });
    this.fundingCursors.set(record.marketId, { marketId: record.marketId, windowEnd: record.windowEnd, updatedAt: record.updatedAt });
    return update;
  }

  confirmFundingCycleFailure(cycleId: Hex,
    expected: { marketId: string; oldFundingIndex: bigint; newFundingIndex: bigint; settlementTxHash: Hex; observedAt: number }): void {
    const record = this.fundingCycles.get(cycleId);
    if (!record || !record.submissionAttempted || record.marketId !== expected.marketId ||
        record.oldFundingIndex !== expected.oldFundingIndex || record.newFundingIndex !== expected.newFundingIndex ||
        record.settlementTxHash !== expected.settlementTxHash || !Number.isSafeInteger(expected.observedAt)) {
      throw new Error("failed funding transaction identity changed");
    }
    if (record.status === "retired" && record.failureConfirmed) return;
    if (record.status !== "attempted") throw new Error("funding transaction is not awaiting reconciliation");
    const market = this.markets.get(record.marketId);
    const cursor = this.fundingCursors.get(record.marketId);
    if (!market || market.fundingIndex !== record.oldFundingIndex || (cursor && cursor.windowEnd > record.windowEnd)) {
      throw new Error("failed funding transaction index requires reconciliation");
    }
    this.fundingCycles.set(cycleId, { ...record, status: "retired", failureConfirmed: true,
      reason: "exact funding transaction failed without changing the index", updatedAt: expected.observedAt });
    this.fundingCursors.set(record.marketId, { marketId: record.marketId, windowEnd: record.windowEnd, updatedAt: expected.observedAt });
  }

  addFundingPremiumSamples(records: FundingPremiumSampleRecord[]): void {
    for (const record of records) {
      const key = `${record.marketId}:${record.sampledAt}`;
      this.fundingPremiumSamples.set(key, record);
    }
    trimFundingPremiumSamples(this.fundingPremiumSamples);
  }

  addLiquidationAutomationJob(record: LiquidationAutomationJobRecord): void {
    if (this.liquidationAutomationJobs.has(record.jobId)) {
      throw new Error("liquidation automation job already exists");
    }
    this.liquidationAutomationJobs.set(record.jobId, record);
  }

  updateLiquidationAutomationJob(record: LiquidationAutomationJobRecord): void {
    if (!this.liquidationAutomationJobs.has(record.jobId)) {
      throw new Error("liquidation automation job not found");
    }
    this.liquidationAutomationJobs.set(record.jobId, record);
  }

  addBatchExecutionRun(record: BatchExecutionRunRecord, intentCommitments: Hex[] = []): void {
    if (this.batchExecutionRuns.has(record.runId)) {
      throw new Error("batch execution run already exists");
    }
    this.batchExecutionRuns.set(record.runId, record);
    this.associateBatchExecutionRun(record.runId, intentCommitments);
    trimBatchExecutionRuns(this.batchExecutionRuns);
  }

  upsertBatchExecutionRun(record: BatchExecutionRunRecord, intentCommitments: Hex[] = []): void {
    this.batchExecutionRuns.set(record.runId, record);
    this.associateBatchExecutionRun(record.runId, intentCommitments);
    trimBatchExecutionRuns(this.batchExecutionRuns);
  }

  addIntent(record: IntentRecord, privateMatchIntent?: PrivateMatchIntent): void {
    this.addIntentRecord(record, privateMatchIntent, true);
  }

  restoreConfirmedIntent(record: IntentRecord, privateMatchIntent: PrivateMatchIntent): void {
    const previous = this.intents.get(record.intentCommitment);
    if (previous) {
      assertPrivateMatchIntent(previous, privateMatchIntent);
      if (previous.matchingPayloadCommitment !== record.matchingPayloadCommitment ||
          previous.noteNullifier !== record.noteNullifier || previous.ownerCommitment !== record.ownerCommitment) {
        throw new Error("confirmed intent recovery conflicts with local state");
      }
      this.privateMatchIntents.set(record.intentCommitment, privateMatchIntent);
      return;
    }
    this.addIntentRecord(record, privateMatchIntent, false);
  }

  private addIntentRecord(record: IntentRecord, privateMatchIntent: PrivateMatchIntent | undefined, currentRootRequired: boolean): void {
    if (this.intents.has(record.intentCommitment)) {
      throw new Error("intent commitment already exists");
    }
    if (!record.batchDigest || !record.marketDigest || !record.ownerCommitmentField) {
      throw new Error("intent public binding is required");
    }
    if (!record.matchingPayloadCommitment) {
      throw new Error("intent matching payload commitment is required");
    }
    if (privateMatchIntent) {
      assertPrivateMatchIntent(record, privateMatchIntent);
    }
    assertProof(this, record.proof);
    if (currentRootRequired && record.marginRoot !== this.marginMembershipRoot()) {
      throw new Error("intent margin root is not current");
    }
    if (this.spentNullifiers.has(record.noteNullifier)) {
      throw new Error("intent nullifier already spent");
    }
    for (const existing of this.intents.values()) {
      const lifecycle = this.orderLifecycle.get(existing.intentCommitment);
      if (existing.noteNullifier === record.noteNullifier && lifecycle?.status !== "cancelled") {
        throw new Error("intent nullifier already locked");
      }
    }
    if (privateMatchIntent) this.privateMatchIntents.set(record.intentCommitment, privateMatchIntent);
    this.intents.set(record.intentCommitment, record);
    const now = Date.now();
    this.orderLifecycle.set(record.intentCommitment, {
      batchId: record.batchId,
      createdAt: now,
      intentCommitment: record.intentCommitment,
      marketId: record.marketId,
      ownerCommitment: record.ownerCommitment,
      status: "open",
      updatedAt: now,
    });
  }

  updateIntentSubmissionTxHash(intentCommitment: Hex, submissionTxHash: Hex): IntentRecord {
    const intent = this.intents.get(intentCommitment);
    if (!intent) throw new Error("unknown intent");
    const updated = { ...intent, submissionTxHash };
    this.intents.set(intentCommitment, updated);
    return updated;
  }

  updateSettlementTransactions(
    settlementDigest: Hex,
    transactions: Pick<BatchSettlement, "proofVerificationTxHash" | "settlementTxHash"> & {
      proverJobId?: string;
    },
  ): BatchSettlement {
    const entry = [...this.settlements.entries()].find(([, settlement]) =>
      settlement.settlementDigest === settlementDigest
    );
    if (!entry) throw new Error("unknown settlement");
    const [key, settlement] = entry;
    const { proverJobId, ...transactionHashes } = transactions;
    const updated = {
      ...settlement,
      ...transactionHashes,
      proof: proverJobId
        ? { ...settlement.proof, proverJobId }
        : settlement.proof,
    };
    this.settlements.set(key, updated);
    return updated;
  }

  confirmSettlementOnchain(
    key: string,
    expected: Pick<BatchSettlement, "batchId" | "marketId" | "settlementDigest">,
  ): BatchSettlement {
    const current = this.settlements.get(key);
    if (!current || current.batchId !== expected.batchId || current.marketId !== expected.marketId ||
        current.settlementDigest !== expected.settlementDigest) {
      throw new Error("settlement confirmation identity changed");
    }
    const confirmed = { ...current, onchainConfirmed: true };
    this.settlements.set(key, confirmed);
    return confirmed;
  }

  settlementByDigest(settlementDigest: Hex): BatchSettlement | undefined {
    return [...this.settlements.values()].find((settlement) =>
      settlement.settlementDigest === settlementDigest
    );
  }

  cancelOrder(intentCommitment: Hex, cancellationTxHash?: Hex): OrderLifecycleRecord {
    const existing = this.orderLifecycle.get(intentCommitment);
    if (!existing) throw new Error("unknown order");
    if (existing.status === "filled") throw new Error("filled order cannot be cancelled");
    if (existing.status === "cancelled") throw new Error("order already cancelled");
    if (existing.status === "partially-filled" && existing.residualCommitment) {
      throw new Error("This order has rolled over; cancel its active residual instead");
    }

    const record = {
      ...existing,
      ...(cancellationTxHash ? { cancellationTxHash } : {}),
      status: "cancelled" as const,
      updatedAt: Date.now(),
    };
    this.orderLifecycle.set(intentCommitment, record);
    return record;
  }

  assertOrderCancellable(intentCommitment: Hex): OrderLifecycleRecord {
    const existing = this.orderLifecycle.get(intentCommitment);
    if (!existing) throw new Error("unknown order");
    if (existing.status === "filled") throw new Error("filled order cannot be cancelled");
    if (existing.status === "cancelled") throw new Error("order already cancelled");
    if (existing.status === "partially-filled" && existing.residualCommitment) {
      throw new Error("This order has rolled over; cancel its active residual instead");
    }
    return existing;
  }

  spend(nullifier: Hex): void {
    if (this.spentNullifiers.has(nullifier)) throw new Error("nullifier already spent");
    this.spentNullifiers.add(nullifier);
  }

  recordProof(proof: ProofMeta): void {
    this.proofs.add(proofKey(proof));
  }

  hasProof(proof: ProofMeta): boolean {
    return this.proofs.has(proofKey(proof));
  }

  addSettlement(
    settlement: BatchSettlement,
    positionOpenings: PositionLifecycleRecord[] = [],
    residualOrders: ResidualOrderRecord[] = [],
    accountEvents: AccountEventRecord[] = [],
    privateMatchIntents: PrivateMatchIntent[] = [],
  ): void {
    const key = `${settlement.marketId}:${settlement.batchId}`;
    if (this.settlements.has(key)) throw new Error("batch already settled");
    if (!settlement.matchTranscriptDigest) throw new Error("match transcript digest is required");
    assertProof(this, settlement.proof);
    this.validatePositionOpenings(settlement, positionOpenings);
    this.validateResidualOrders(settlement, residualOrders);
    const firstPositionIndex = this.positionCommitments.size;
    for (const commitment of settlement.newCommitments) {
      this.positionCommitments.add(commitment);
    }
    for (const commitment of settlement.marginChangeCommitments ?? []) {
      this.marginCommitments.add(commitment);
    }
    for (const nullifier of settlement.spentNullifiers) {
      this.spend(nullifier);
    }
    this.applySettlementOrderUpdates(settlement);
    for (const opening of positionOpenings) {
      const offset = settlement.newCommitments.indexOf(opening.positionCommitment);
      if (offset < 0) throw new Error("position opening commitment is not in settlement");
      this.addPositionOpening({
        ...opening,
        positionIndex: firstPositionIndex + offset,
      });
    }
    const privateByIntent = new Map(privateMatchIntents.map((payload) => [payload.intentCommitment, payload]));
    for (const residual of residualOrders) {
      this.addResidualOrder(residual, privateByIntent.get(residual.intentCommitment));
    }
    for (const event of accountEvents) {
      this.addAccountEvent(event);
    }
    this.settlements.set(key, settlement);
    this.marketSettlementVolumes.set(settlement.settlementDigest, {
      marketId: settlement.marketId,
      matchedVolume: settlement.aggregateVolume / 2n,
      settledAt: Date.now(),
      settlementDigest: settlement.settlementDigest,
    });
  }

  addResidualOrder(record: ResidualOrderRecord, privateMatchIntent?: PrivateMatchIntent): void {
    if (this.residualOrders.has(record.intentCommitment)) {
      throw new Error("residual order already exists");
    }
    if (!record.matchingPayloadCommitment) throw new Error("residual order matching payload commitment is required");
    if (privateMatchIntent) {
      assertPrivateMatchIntent(record, privateMatchIntent);
      this.privateMatchIntents.set(record.intentCommitment, privateMatchIntent);
    }

    this.residualOrders.set(record.intentCommitment, record);
    this.orderLifecycle.set(record.intentCommitment, {
      batchId: record.batchId,
      createdAt: record.createdAt,
      intentCommitment: record.intentCommitment,
      marketId: record.marketId,
      ownerCommitment: record.ownerCommitment,
      status: "open",
      updatedAt: record.updatedAt,
    });
  }

  addPositionOpening(record: PositionLifecycleRecord): void {
    if (this.positionLifecycle.has(record.positionCommitment)) {
      throw new Error("position lifecycle already exists");
    }
    if (record.status !== "open") {
      throw new Error("position opening must be open");
    }
    if (!this.positionCommitments.has(record.positionCommitment)) {
      throw new Error("unknown position commitment");
    }
    this.positionLifecycle.set(record.positionCommitment, record);
  }

  private applySettlementOrderUpdates(settlement: BatchSettlement): void {
    const now = Date.now();
    const updates = settlement.orderUpdates ?? fallbackOrderUpdates(this, settlement);
    for (const update of updates) {
      const intent = this.intents.get(update.intentCommitment);
      const residual = this.residualOrders.get(update.intentCommitment);
      if (!intent && !residual) throw new Error("unknown settlement intent");
      const previous = this.orderLifecycle.get(update.intentCommitment);
      const order = intent ?? residual!;
      this.orderLifecycle.set(update.intentCommitment, {
        batchId: order.batchId,
        createdAt: previous?.createdAt ?? now,
        intentCommitment: update.intentCommitment,
        matchingRunId: previous?.matchingRunId,
        marketId: order.marketId,
        ownerCommitment: order.ownerCommitment,
        residualCommitment: update.residualCommitment,
        status: update.status,
        updatedAt: now,
      });
    }
  }

  addLiquidation(record: LiquidationRecord): void {
    if (this.liquidations.has(record.positionNullifier)) {
      throw new Error("position already liquidated");
    }
    assertProof(this, record.proof);
    this.spend(record.positionNullifier);
    this.markPositionLiquidated(record);
    this.liquidations.set(record.positionNullifier, record);
  }

  private associateBatchExecutionRun(runId: Hex, intentCommitments: Hex[]): void {
    for (const intentCommitment of intentCommitments) {
      const order = this.orderLifecycle.get(intentCommitment);
      if (!order || order.status !== "open" || order.matchingRunId === runId) continue;
      this.orderLifecycle.set(intentCommitment, {
        ...order,
        matchingRunId: runId,
      });
    }
  }

  addConditionalOrder(record: ConditionalOrderCommitment): void {
    if (this.conditionalOrders.has(record.closeCommitment)) {
      throw new Error("conditional order already exists");
    }
    this.conditionalOrders.set(record.closeCommitment, record);
  }

  hasConditionalOrder(closeCommitment: Hex): boolean {
    return this.conditionalOrders.has(closeCommitment);
  }

  addConditionalClose(record: ConditionalOrderRecord): void {
    if (this.conditionalCloses.has(record.closeCommitment)) {
      throw new Error("conditional close already exists");
    }
    assertProof(this, record.proof);
    this.conditionalCloses.set(record.closeCommitment, record);
  }

  addPositionClose(record: PositionCloseRecord): void {
    const conditionalClose = this.conditionalCloses.get(record.closeCommitment);
    if (!conditionalClose) {
      throw new Error("conditional close not triggered");
    }
    if (
      conditionalClose.marketId !== record.marketId ||
      conditionalClose.positionNullifier !== record.positionNullifier
    ) {
      throw new Error("conditional close not triggered");
    }
    this.addPositionCloseRecord(record);
  }

  addManualPositionClose(record: PositionCloseRecord): void {
    this.addPositionCloseRecord(record);
  }

  addPairedPositionCloses(
    trader: PositionCloseRecord,
    maker: PositionCloseRecord,
    conditional: boolean,
  ): void {
    if (trader.marketId !== maker.marketId || trader.markPrice !== maker.markPrice ||
      trader.positionNullifier === maker.positionNullifier ||
      trader.closeCommitment === maker.closeCommitment ||
      trader.marginOutputCommitment === maker.marginOutputCommitment) {
      throw new Error("invalid paired position closes");
    }
    if (this.positionCloses.has(trader.closeCommitment) ||
      this.positionCloses.has(maker.closeCommitment) ||
      this.spentNullifiers.has(trader.positionNullifier) ||
      this.spentNullifiers.has(maker.positionNullifier)) {
      throw new Error("paired position already closed");
    }
    assertProof(this, trader.proof);
    assertProof(this, maker.proof);
    if (conditional) {
      const trigger = this.conditionalCloses.get(trader.closeCommitment);
      if (!trigger || trigger.marketId !== trader.marketId ||
        trigger.positionNullifier !== trader.positionNullifier) {
        throw new Error("conditional close not triggered");
      }
    }
    this.addPositionCloseRecord(trader);
    this.addPositionCloseRecord(maker);
  }

  private addPositionCloseRecord(record: PositionCloseRecord): void {
    if (this.positionCloses.has(record.closeCommitment)) {
      throw new Error("position close already exists");
    }
    assertProof(this, record.proof);
    this.spend(record.positionNullifier);
    const outputPositionIndex = this.positionCommitments.size;
    this.positionCommitments.add(record.newPositionCommitment);
    this.marginCommitments.add(record.marginOutputCommitment);
    this.markPositionClosed(record);
    this.positionCloses.set(record.closeCommitment, {
      ...record,
      outputPositionIndex,
      outputPositionRoot: this.positionMembershipRoot(),
    });
  }

  addDisclosure(record: DisclosureRecord): void {
    if (this.disclosures.has(record.disclosureId)) {
      throw new Error("disclosure already exists");
    }
    assertProof(this, record.proof);
    this.disclosures.set(record.disclosureId, record);
  }

  addWithdrawal(record: WithdrawalRecord): void {
    if (this.withdrawals.has(record.nullifier)) {
      throw new Error("withdrawal already exists");
    }
    assertProof(this, record.proof);
    this.spend(record.nullifier);
    if (record.changeCommitment !== "0x0") {
      this.marginCommitments.add(record.changeCommitment);
    }
    this.withdrawals.set(record.nullifier, record);
  }

  addAccountEvent(record: AccountEventRecord): void {
    if (this.accountEvents.has(record.eventId)) {
      throw new Error("account event already exists");
    }
    this.accountEvents.set(record.eventId, record);
  }

  upsertAccountEncryptionKey(record: AccountEncryptionKeyRecord): void {
    this.accountEncryptionKeys.set(record.ownerCommitment, record);
  }

  accountEncryptionKey(ownerCommitment: Hex): AccountEncryptionKeyRecord | undefined {
    return this.accountEncryptionKeys.get(ownerCommitment);
  }

  accountEventsFor(ownerCommitment: Hex): AccountEventRecord[] {
    return [...this.accountEvents.values()]
      .filter((event) => event.ownerCommitment === ownerCommitment)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  positionsFor(ownerCommitment: Hex): PositionLifecycleRecord[] {
    return [...this.positionLifecycle.values()]
      .filter((position) => position.ownerCommitment === ownerCommitment)
      .sort((a, b) => a.openedAt - b.openedAt || a.positionCommitment.localeCompare(b.positionCommitment));
  }

  positionFor(positionCommitment: Hex, positionNullifier: Hex): PositionLifecycleRecord | undefined {
    return this.findPosition(positionCommitment, positionNullifier);
  }

  private validatePositionOpenings(
    settlement: BatchSettlement,
    openings: PositionLifecycleRecord[],
  ): void {
    const expectedCommitments = new Set(settlement.newCommitments);
    for (const opening of openings) {
      if (opening.batchId !== settlement.batchId) {
        throw new Error("position opening batch mismatch");
      }
      if (opening.marketId !== settlement.marketId) {
        throw new Error("position opening market mismatch");
      }
      if (opening.settlementDigest !== settlement.settlementDigest) {
        throw new Error("position opening settlement mismatch");
      }
      if (!expectedCommitments.has(opening.positionCommitment)) {
        throw new Error("position opening commitment mismatch");
      }
    }
  }

  private validateResidualOrders(
    settlement: BatchSettlement,
    residuals: ResidualOrderRecord[],
  ): void {
    const residualUpdates = new Map(
      (settlement.orderUpdates ?? [])
        .filter((update) => update.status === "partially-filled" && update.residualCommitment)
        .map((update) => [update.residualCommitment!, update.intentCommitment]),
    );
    for (const residual of residuals) {
      if (residual.batchId !== settlement.batchId) {
        throw new Error("residual order batch mismatch");
      }
      if (residual.marketId !== settlement.marketId) {
        throw new Error("residual order market mismatch");
      }
      const source = residualUpdates.get(residual.intentCommitment);
      if (!source) {
        throw new Error("residual order update mismatch");
      }
      if (source !== residual.sourceIntentCommitment) {
        throw new Error("residual order source mismatch");
      }
    }
  }

  private markPositionClosed(record: PositionCloseRecord): void {
    const position = this.findPosition(record.positionCommitment, record.positionNullifier);
    if (!position) return;
    this.positionLifecycle.set(position.positionCommitment, {
      ...position,
      closeCommitment: record.closeCommitment,
      marginOutputCommitment: record.marginOutputCommitment,
      newPositionCommitment: record.newPositionCommitment,
      status: "closed",
      updatedAt: Date.now(),
    });
  }

  private markPositionLiquidated(record: LiquidationRecord): void {
    const position = this.findPosition(record.positionCommitment, record.positionNullifier);
    if (!position) return;
    this.positionLifecycle.set(position.positionCommitment, {
      ...position,
      liquidationRewardCommitment: record.rewardCommitment,
      status: "liquidated",
      updatedAt: Date.now(),
    });
  }

  private findPosition(positionCommitment: Hex, positionNullifier: Hex): PositionLifecycleRecord | undefined {
    const byCommitment = this.positionLifecycle.get(positionCommitment);
    if (byCommitment) return byCommitment;
    return [...this.positionLifecycle.values()].find(
      (position) => position.positionNullifier === positionNullifier,
    );
  }
}

export function retainedBatchExecutionRuns(
  entries: [Hex, BatchExecutionRunRecord][],
): [Hex, BatchExecutionRunRecord][] {
  const required = new Set(entries.filter(([, run]) => run.status !== "settled" && (run.submissionAttempted ||
    ((run.status === "running" || run.status === "failed") && Boolean(run.intentCommitments?.length) &&
      (run.phase === "proving" || Boolean(run.settlementDigest)))))
    .map(([key]) => key));
  const recent = entries.filter(([key]) => !required.has(key)).slice(-BATCH_EXECUTION_RUN_RETENTION);
  const retained = new Set([...required, ...recent.map(([key]) => key)]);
  return entries.filter(([key]) => retained.has(key));
}

export function backfillMarketSettlementVolumes(store: Pick<
  ProtocolStore,
  "batchExecutionRuns" | "marketSettlementVolumes"
>): void {
  for (const run of store.batchExecutionRuns.values()) {
    if (
      run.status !== "settled" ||
      run.aggregateVolume === undefined ||
      run.completedAt === undefined ||
      !run.settlementDigest ||
      store.marketSettlementVolumes.has(run.settlementDigest)
    ) {
      continue;
    }
    store.marketSettlementVolumes.set(run.settlementDigest, {
      marketId: run.marketId,
      matchedVolume: run.aggregateVolume / 2n,
      settledAt: run.completedAt,
      settlementDigest: run.settlementDigest,
    });
  }
}

export function retainedFundingPremiumSamples(
  entries: [string, FundingPremiumSampleRecord][],
): [string, FundingPremiumSampleRecord][] {
  const retained = new Set<string>();
  const counts = new Map<string, number>();
  for (const [key, record] of [...entries].reverse()) {
    const count = counts.get(record.marketId) ?? 0;
    if (count >= FUNDING_PREMIUM_SAMPLE_RETENTION) continue;
    counts.set(record.marketId, count + 1);
    retained.add(key);
  }
  return entries.filter(([key]) => retained.has(key));
}

function trimBatchExecutionRuns(runs: Map<Hex, BatchExecutionRunRecord>): void {
  if (runs.size <= BATCH_EXECUTION_RUN_RETENTION) return;
  const retained = new Set(retainedBatchExecutionRuns([...runs.entries()]).map(([key]) => key));
  for (const key of runs.keys()) if (!retained.has(key)) runs.delete(key);
}

function trimFundingPremiumSamples(samples: Map<string, FundingPremiumSampleRecord>): void {
  const retained = new Map(retainedFundingPremiumSamples([...samples.entries()]));
  for (const key of samples.keys()) {
    if (!retained.has(key)) samples.delete(key);
  }
}

function fallbackOrderUpdates(store: ProtocolStore, settlement: BatchSettlement) {
  return [...store.intents.values()]
    .filter((intent) =>
      intent.marketId === settlement.marketId &&
      intent.batchId === settlement.batchId &&
      settlement.spentNullifiers.includes(intent.noteNullifier),
    )
    .map((intent) => ({
      intentCommitment: intent.intentCommitment,
      status: "filled" as const,
    }));
}

function proofKey(proof: ProofMeta): string {
  return [
    proof.circuitKey,
    proof.verifierHash,
    proof.publicInputHash,
    proof.proofDigest,
  ].join(":");
}

function assertProof(store: ProtocolStore, proof: ProofMeta): void {
  if (!store.hasProof(proof)) throw new Error("unverified proof");
}

function assertFundingCycle(record: FundingCycleRecord): void {
  const maxIndex = (1n << 127n) - 1n;
  if (!/^0x[0-9a-f]{64}$/i.test(record.cycleId) || BigInt(record.cycleId) === 0n || BigInt(record.cycleId) >= FIELD_PRIME || !record.marketId ||
      !Number.isSafeInteger(record.windowStart) || record.windowStart < 0 ||
      !Number.isSafeInteger(record.windowEnd) || record.windowEnd <= record.windowStart ||
      !Number.isSafeInteger(record.intervalMs) || record.intervalMs <= 0 ||
      !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0 || record.markPrice <= 0n ||
      record.oldFundingIndex < -maxIndex || record.oldFundingIndex > maxIndex ||
      record.newFundingIndex < -maxIndex || record.newFundingIndex > maxIndex ||
      !["prepared", "attempted", "settled", "skipped", "retired"].includes(record.status)) {
    throw new Error("invalid funding cycle journal");
  }
  const settlement = record.settlement;
  if (settlement && (settlement.cycleId !== record.cycleId || settlement.marketId !== record.marketId || settlement.appliedAt !== record.windowEnd ||
      settlement.oldFundingIndex !== record.oldFundingIndex || settlement.newFundingIndex !== record.newFundingIndex ||
      settlement.markPrice !== record.markPrice || settlement.premiumRate !== record.premiumRate ||
      settlement.intervalMs !== record.intervalMs || settlement.elapsedMs !== record.windowEnd - record.windowStart ||
      settlement.maxFundingDelta !== record.maxFundingDelta)) throw new Error("funding proof does not match its journal");
  if (record.submissionAttempted && (!settlement || record.status === "prepared" ||
      (record.status === "retired" && !record.failureConfirmed) || record.status === "skipped")) {
    throw new Error("invalid attempted funding journal");
  }
  if ((record.settlementTxHash === undefined) !== (record.preparedXdr === undefined) ||
      (record.settlementTxHash !== undefined && (!/^0x[0-9a-f]{64}$/i.test(record.settlementTxHash) || !record.preparedXdr))) {
    throw new Error("invalid prepared funding transaction");
  }
}
