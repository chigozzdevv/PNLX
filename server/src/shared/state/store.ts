import type {
  AccountEventRecord,
  AccountEncryptionKeyRecord,
  BatchExecutionRunRecord,
  BatchSettlement,
  ConditionalOrderCommitment,
  ConditionalOrderRecord,
  DisclosureRecord,
  FundingUpdateRecord,
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
import { EMPTY_ROOT, fieldMerkleProof, fieldMerkleRoot, merkleRoot } from "@pnlx/crypto";
import { assertPrivateMatchIntent } from "@/workers/batch-matcher/private-intent";

export const BATCH_EXECUTION_RUN_RETENTION = 1_000;
export const FUNDING_PREMIUM_SAMPLE_RETENTION = 120;

export class ProtocolStore {
  readonly marginCommitments = new Set<Hex>();
  readonly positionCommitments = new Set<Hex>();
  readonly spentNullifiers = new Set<Hex>();
  readonly intents = new Map<string, IntentRecord>();
  readonly residualOrders = new Map<Hex, ResidualOrderRecord>();
  readonly orderLifecycle = new Map<Hex, OrderLifecycleRecord>();
  readonly positionLifecycle = new Map<Hex, PositionLifecycleRecord>();
  readonly markets = new Map<string, MarketConfig>();
  readonly settlements = new Map<string, BatchSettlement>();
  readonly liquidations = new Map<Hex, LiquidationRecord>();
  readonly conditionalOrders = new Map<Hex, ConditionalOrderCommitment>();
  readonly conditionalCloses = new Map<Hex, ConditionalOrderRecord>();
  readonly positionCloses = new Map<Hex, PositionCloseRecord>();
  readonly disclosures = new Map<Hex, DisclosureRecord>();
  readonly fundingUpdates = new Map<string, FundingUpdateRecord>();
  readonly fundingPremiumSamples = new Map<string, FundingPremiumSampleRecord>();
  readonly liquidationAutomationJobs = new Map<Hex, LiquidationAutomationJobRecord>();
  readonly batchExecutionRuns = new Map<Hex, BatchExecutionRunRecord>();
  readonly withdrawals = new Map<Hex, WithdrawalRecord>();
  readonly accountEvents = new Map<Hex, AccountEventRecord>();
  readonly accountEncryptionKeys = new Map<Hex, AccountEncryptionKeyRecord>();
  readonly pendingAssetDeposits = new Map<Hex, PendingAssetDepositRecord>();
  readonly privateMatchIntents = new Map<Hex, PrivateMatchIntent>();
  readonly proofs = new Set<string>();

  marginRoot(): Hex {
    return this.marginCommitments.size === 0
      ? EMPTY_ROOT
      : merkleRoot([...this.marginCommitments]);
  }

  marginMembershipRoot(): Hex {
    return fieldMerkleRoot([...this.marginCommitments]);
  }

  marginMembershipProof(commitment: Hex) {
    return fieldMerkleProof([...this.marginCommitments], commitment);
  }

  positionRoot(): Hex {
    return this.positionCommitments.size === 0
      ? EMPTY_ROOT
      : merkleRoot([...this.positionCommitments]);
  }

  positionMembershipRoot(): Hex {
    return fieldMerkleRoot([...this.positionCommitments]);
  }

  positionMembershipProof(commitment: Hex) {
    return fieldMerkleProof([...this.positionCommitments], commitment);
  }

  positionMembershipRootWith(commitment: Hex): Hex {
    return fieldMerkleRoot([...this.positionCommitments, commitment]);
  }

  positionMembershipRootWithMany(commitments: Hex[]): Hex {
    return fieldMerkleRoot([...this.positionCommitments, ...commitments]);
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

  addBatchExecutionRun(record: BatchExecutionRunRecord): void {
    if (this.batchExecutionRuns.has(record.runId)) {
      throw new Error("batch execution run already exists");
    }
    this.batchExecutionRuns.set(record.runId, record);
    trimBatchExecutionRuns(this.batchExecutionRuns);
  }

  upsertBatchExecutionRun(record: BatchExecutionRunRecord): void {
    this.batchExecutionRuns.set(record.runId, record);
    trimBatchExecutionRuns(this.batchExecutionRuns);
  }

  addIntent(record: IntentRecord, privateMatchIntent?: PrivateMatchIntent): void {
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
      this.privateMatchIntents.set(record.intentCommitment, privateMatchIntent);
    }
    assertProof(this, record.proof);
    if (record.marginRoot !== this.marginMembershipRoot()) {
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
      boundlessRequestId?: Hex;
    },
  ): BatchSettlement {
    const entry = [...this.settlements.entries()].find(([, settlement]) =>
      settlement.settlementDigest === settlementDigest
    );
    if (!entry) throw new Error("unknown settlement");
    const [key, settlement] = entry;
    const { boundlessRequestId, ...transactionHashes } = transactions;
    const updated = {
      ...settlement,
      ...transactionHashes,
      proof: boundlessRequestId
        ? { ...settlement.proof, boundlessRequestId }
        : settlement.proof,
    };
    this.settlements.set(key, updated);
    return updated;
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
      this.addPositionOpening(opening);
    }
    const privateByIntent = new Map(privateMatchIntents.map((payload) => [payload.intentCommitment, payload]));
    for (const residual of residualOrders) {
      this.addResidualOrder(residual, privateByIntent.get(residual.intentCommitment));
    }
    for (const event of accountEvents) {
      this.addAccountEvent(event);
    }
    this.settlements.set(key, settlement);
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

  private addPositionCloseRecord(record: PositionCloseRecord): void {
    if (this.positionCloses.has(record.closeCommitment)) {
      throw new Error("position close already exists");
    }
    assertProof(this, record.proof);
    this.spend(record.positionNullifier);
    this.positionCommitments.add(record.newPositionCommitment);
    this.marginCommitments.add(record.marginOutputCommitment);
    this.markPositionClosed(record);
    this.positionCloses.set(record.closeCommitment, record);
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
  return entries.slice(-BATCH_EXECUTION_RUN_RETENTION);
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
  while (runs.size > BATCH_EXECUTION_RUN_RETENTION) {
    const oldest = runs.keys().next().value as Hex | undefined;
    if (!oldest) return;
    runs.delete(oldest);
  }
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
