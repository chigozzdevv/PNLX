import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
import {
  backfillMarketSettlementVolumes,
  ProtocolStore,
  retainedBatchExecutionRuns,
  type MarketSettlementVolumeRecord,
} from "@/shared/state/store";
import type { DelegatedConditionalPolicy } from "@/shared/protocol/delegated-policies";
import type { PendingPairedClose } from "@/shared/protocol/paired-close-journal";
import type { PendingIntentSubmission } from "@/shared/protocol/intent-submission-journal";

const ZERO_HEX = "0x0" as Hex;

interface ProtocolStoreSnapshot {
  accountEvents: [Hex, AccountEventRecord][];
  accountEncryptionKeys: [Hex, AccountEncryptionKeyRecord][];
  batchExecutionRuns: [Hex, BatchExecutionRunRecord][];
  conditionalCloses: [Hex, ConditionalOrderRecord][];
  conditionalOrders: [Hex, ConditionalOrderCommitment][];
  delegatedPolicies?: [Hex, DelegatedConditionalPolicy][];
  pendingPairedCloses?: [Hex, PendingPairedClose][];
  pendingIntentSubmissions?: [Hex, PendingIntentSubmission][];
  disclosures: [Hex, DisclosureRecord][];
  fundingUpdates: [string, FundingUpdateRecord][];
  intents: [string, IntentRecord][];
  liquidationAutomationJobs: [Hex, LiquidationAutomationJobRecord][];
  liquidations: [Hex, LiquidationRecord][];
  marginCommitments: Hex[];
  markets: [string, MarketConfig][];
  marketSettlementVolumes?: [Hex, MarketSettlementVolumeRecord][];
  orderLifecycle: [Hex, OrderLifecycleRecord][];
  pendingAssetDeposits: [Hex, PendingAssetDepositRecord][];
  positionCloses: [Hex, PositionCloseRecord][];
  positionCommitments: Hex[];
  positionLifecycle: [Hex, PositionLifecycleRecord][];
  privateMatchIntents?: [Hex, PrivateMatchIntent][];
  proofs: string[];
  residualOrders: [Hex, ResidualOrderRecord][];
  settlements: [string, BatchSettlement][];
  spentNullifiers: Hex[];
  withdrawals: [Hex, WithdrawalRecord][];
}

export class FileProtocolStore extends ProtocolStore {
  private saveDepth = 0;

  constructor(private readonly path: string) {
    super();
    this.load();
  }

  override addMarginCommitment(commitment: Hex): void {
    this.persist(() => super.addMarginCommitment(commitment));
  }

  override replaceMarginCommitments(commitments: Hex[]): void {
    this.persist(() => super.replaceMarginCommitments(commitments));
  }

  override addPendingAssetDeposit(record: PendingAssetDepositRecord): void {
    this.persist(() => super.addPendingAssetDeposit(record));
  }

  override finalizePendingAssetDeposit(
    commitment: Hex,
    relay: { relayId: Hex; txHash?: Hex },
  ): PendingAssetDepositRecord {
    return this.persist(() => super.finalizePendingAssetDeposit(commitment, relay));
  }

  override confirmPendingAssetDeposit(
    commitment: Hex,
    confirmation: NonNullable<PendingAssetDepositRecord["confirmedRecovery"]>,
    commitments: Hex[],
  ): PendingAssetDepositRecord {
    const pending = this.pendingAssetDeposits.get(commitment), margins = [...this.marginCommitments], proofs = [...this.proofs];
    try { return this.persist(() => super.confirmPendingAssetDeposit(commitment, confirmation, commitments)); }
    catch (error) {
      this.marginCommitments.clear(); for (const value of margins) this.marginCommitments.add(value);
      this.proofs.clear(); for (const value of proofs) this.proofs.add(value);
      if (pending) this.pendingAssetDeposits.set(commitment, pending);
      throw error;
    }
  }

  override addMarket(market: MarketConfig): void {
    this.persist(() => super.addMarket(market));
  }

  override updateMarket(market: MarketConfig): void {
    this.persist(() => super.updateMarket(market));
  }

  override addFundingUpdate(record: FundingUpdateRecord): void {
    this.persist(() => super.addFundingUpdate(record));
  }

  override addFundingPremiumSamples(records: FundingPremiumSampleRecord[]): void {
    this.persist(() => super.addFundingPremiumSamples(records));
  }

  override addLiquidationAutomationJob(record: LiquidationAutomationJobRecord): void {
    this.persist(() => super.addLiquidationAutomationJob(record));
  }

  override updateLiquidationAutomationJob(record: LiquidationAutomationJobRecord): void {
    this.persist(() => super.updateLiquidationAutomationJob(record));
  }

  override addBatchExecutionRun(record: BatchExecutionRunRecord, intentCommitments: Hex[] = []): void {
    this.persist(() => super.addBatchExecutionRun(record, intentCommitments));
  }

  override upsertBatchExecutionRun(record: BatchExecutionRunRecord, intentCommitments: Hex[] = []): void {
    this.persist(() => super.upsertBatchExecutionRun(record, intentCommitments));
  }

  override addIntent(record: IntentRecord, privateMatchIntent?: PrivateMatchIntent): void {
    this.persist(() => super.addIntent(record, privateMatchIntent));
  }

  override restoreConfirmedIntent(record: IntentRecord, privateMatchIntent: PrivateMatchIntent): void {
    this.persist(() => super.restoreConfirmedIntent(record, privateMatchIntent));
  }

  override addPendingIntentSubmission(record: PendingIntentSubmission): void {
    this.persist(() => super.addPendingIntentSubmission(record));
  }

  override removePendingIntentSubmission(intentCommitment: Hex): void {
    this.persist(() => super.removePendingIntentSubmission(intentCommitment));
  }

  override updateIntentSubmissionTxHash(intentCommitment: Hex, submissionTxHash: Hex): IntentRecord {
    return this.persist(() => super.updateIntentSubmissionTxHash(intentCommitment, submissionTxHash));
  }

  override updateSettlementTransactions(
    settlementDigest: Hex,
    transactions: Parameters<ProtocolStore["updateSettlementTransactions"]>[1],
  ) {
    return this.persist(() => super.updateSettlementTransactions(settlementDigest, transactions));
  }

  override cancelOrder(intentCommitment: Hex, cancellationTxHash?: Hex): OrderLifecycleRecord {
    return this.persist(() => super.cancelOrder(intentCommitment, cancellationTxHash));
  }

  override spend(nullifier: Hex): void {
    this.persist(() => super.spend(nullifier));
  }

  override recordProof(proof: ProofMeta): void {
    this.persist(() => super.recordProof(proof));
  }

  override addSettlement(
    settlement: BatchSettlement,
    positionOpenings: PositionLifecycleRecord[] = [],
    residualOrders: ResidualOrderRecord[] = [],
    accountEvents: AccountEventRecord[] = [],
    privateMatchIntents: PrivateMatchIntent[] = [],
  ): void {
    this.persist(() =>
      super.addSettlement(settlement, positionOpenings, residualOrders, accountEvents, privateMatchIntents)
    );
  }

  override addPositionOpening(record: PositionLifecycleRecord): void {
    this.persist(() => super.addPositionOpening(record));
  }

  override addResidualOrder(record: ResidualOrderRecord, privateMatchIntent?: PrivateMatchIntent): void {
    this.persist(() => super.addResidualOrder(record, privateMatchIntent));
  }

  override addLiquidation(record: LiquidationRecord): void {
    this.persist(() => super.addLiquidation(record));
  }

  override addConditionalOrder(record: ConditionalOrderCommitment): void {
    this.persist(() => super.addConditionalOrder(record));
  }

  override addDelegatedConditionalPolicy(record: DelegatedConditionalPolicy): void {
    this.persist(() => super.addDelegatedConditionalPolicy(record));
  }

  override addPendingPairedClose(record: PendingPairedClose): void {
    this.persist(() => super.addPendingPairedClose(record));
  }

  override removePendingPairedClose(journalKey: Hex): void {
    this.persist(() => super.removePendingPairedClose(journalKey));
  }

  override updatePendingPairedClose(record: PendingPairedClose): void {
    this.persist(() => super.updatePendingPairedClose(record));
  }

  override addConditionalClose(record: ConditionalOrderRecord): void {
    this.persist(() => super.addConditionalClose(record));
  }

  override addPositionClose(record: PositionCloseRecord): void {
    this.persist(() => super.addPositionClose(record));
  }

  override addManualPositionClose(record: PositionCloseRecord): void {
    this.persist(() => super.addManualPositionClose(record));
  }

  override addPairedPositionCloses(
    trader: PositionCloseRecord,
    maker: PositionCloseRecord,
    conditional: boolean,
  ): void {
    this.persist(() => super.addPairedPositionCloses(trader, maker, conditional));
  }

  override addDisclosure(record: DisclosureRecord): void {
    this.persist(() => super.addDisclosure(record));
  }

  override addWithdrawal(record: WithdrawalRecord): void {
    this.persist(() => super.addWithdrawal(record));
  }

  override addAccountEvent(record: AccountEventRecord): void {
    this.persist(() => super.addAccountEvent(record));
  }

  override upsertAccountEncryptionKey(record: AccountEncryptionKeyRecord): void {
    this.persist(() => super.upsertAccountEncryptionKey(record));
  }

  private persist<T>(mutation: () => T): T {
    this.saveDepth += 1;
    try {
      const result = mutation();
      if (this.saveDepth === 1) {
        this.save();
      }
      return result;
    } finally {
      this.saveDepth -= 1;
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;

    chmodSync(this.path, 0o600);
    const snapshot = parseSnapshot(readFileSync(this.path, "utf8"));
    this.marginCommitments.clear();
    this.positionCommitments.clear();
    this.spentNullifiers.clear();
    this.intents.clear();
    this.residualOrders.clear();
    this.delegatedPolicies.clear();
    this.pendingPairedCloses.clear();
    this.pendingIntentSubmissions.clear();
    this.orderLifecycle.clear();
    this.positionLifecycle.clear();
    this.markets.clear();
    this.settlements.clear();
    this.marketSettlementVolumes.clear();
    this.liquidations.clear();
    this.conditionalOrders.clear();
    this.conditionalCloses.clear();
    this.positionCloses.clear();
    this.disclosures.clear();
    this.fundingUpdates.clear();
    this.liquidationAutomationJobs.clear();
    this.batchExecutionRuns.clear();
    this.withdrawals.clear();
    this.proofs.clear();
    this.accountEvents.clear();
    this.accountEncryptionKeys.clear();
    this.pendingAssetDeposits.clear();
    this.privateMatchIntents.clear();

    for (const [key, value] of snapshot.accountEvents ?? []) this.accountEvents.set(key, value);
    for (const [key, value] of snapshot.accountEncryptionKeys ?? []) this.accountEncryptionKeys.set(key, value);
    for (const [key, value] of snapshot.pendingAssetDeposits ?? []) this.pendingAssetDeposits.set(key, value);
    for (const value of snapshot.marginCommitments) this.marginCommitments.add(value);
    for (const value of snapshot.positionCommitments) this.positionCommitments.add(value);
    for (const value of snapshot.spentNullifiers) this.spentNullifiers.add(value);
    for (const [key, value] of snapshot.intents) {
      this.intents.set(key, {
        ...value,
        batchDigest: value.batchDigest ?? "0x0",
        marketDigest: value.marketDigest ?? "0x0",
        noteChangeCommitment: value.noteChangeCommitment ?? ZERO_HEX,
        ownerCommitmentField: value.ownerCommitmentField ?? "0x0",
      });
    }
    for (const [key, value] of snapshot.residualOrders ?? []) this.residualOrders.set(key, value);
    for (const [key, value] of snapshot.delegatedPolicies ?? []) {
      if (key.toLowerCase() !== value.intentCommitment.toLowerCase()) throw new Error("delegated conditional snapshot key mismatch");
      super.addDelegatedConditionalPolicy(value);
    }
    for (const [key, value] of snapshot.pendingPairedCloses ?? []) {
      if (key.toLowerCase() !== value.journalKey.toLowerCase()) throw new Error("paired close journal snapshot key mismatch");
      super.addPendingPairedClose(value);
    }
    for (const [key, value] of snapshot.pendingIntentSubmissions ?? []) {
      if (key !== value.intentCommitment) throw new Error("prepared intent snapshot key mismatch");
      super.addPendingIntentSubmission(value);
    }
    for (const [key, value] of snapshot.privateMatchIntents ?? []) {
      this.privateMatchIntents.set(key, {
        ...value,
        noteChangeCommitment: value.noteChangeCommitment ?? ZERO_HEX,
      });
    }
    for (const [key, value] of snapshot.orderLifecycle ?? []) this.orderLifecycle.set(key, value);
    for (const [key, value] of snapshot.positionLifecycle ?? []) this.positionLifecycle.set(key, value);
    for (const [key, value] of snapshot.markets) this.markets.set(key, value);
    for (const [key, value] of snapshot.marketSettlementVolumes ?? []) {
      this.marketSettlementVolumes.set(key, value);
    }
    for (const [key, value] of snapshot.settlements) {
      this.settlements.set(key, {
        ...value,
        matchTranscriptDigest: value.matchTranscriptDigest ?? "0x0",
        marginChangeCommitments: value.marginChangeCommitments ?? [],
        residualMargins: value.residualMargins ?? [],
        orderUpdates: value.orderUpdates ?? [],
        settlementDigest: value.settlementDigest ?? "0x0",
      });
    }
    for (const [key, value] of snapshot.liquidations) this.liquidations.set(key, value);
    for (const [key, value] of snapshot.conditionalOrders) this.conditionalOrders.set(key, value);
    for (const [key, value] of snapshot.conditionalCloses) this.conditionalCloses.set(key, value);
    for (const [key, value] of snapshot.positionCloses) this.positionCloses.set(key, value);
    for (const [key, value] of snapshot.disclosures) this.disclosures.set(key, value);
    for (const [key, value] of snapshot.fundingUpdates ?? []) this.fundingUpdates.set(key, value);
    for (const [key, value] of snapshot.liquidationAutomationJobs ?? []) {
      this.liquidationAutomationJobs.set(key, value);
    }
    for (const [key, value] of retainedBatchExecutionRuns(snapshot.batchExecutionRuns ?? [])) {
      this.batchExecutionRuns.set(key, value);
    }
    backfillMarketSettlementVolumes(this);
    for (const [key, value] of snapshot.withdrawals) this.withdrawals.set(key, value);
    for (const value of snapshot.proofs) this.proofs.add(value);
  }

  private save(): void {
    const snapshot: ProtocolStoreSnapshot = {
      accountEvents: [...this.accountEvents.entries()],
      accountEncryptionKeys: [...this.accountEncryptionKeys.entries()],
      conditionalCloses: [...this.conditionalCloses.entries()],
      conditionalOrders: [...this.conditionalOrders.entries()],
      delegatedPolicies: [...this.delegatedPolicies.entries()],
      pendingPairedCloses: [...this.pendingPairedCloses.entries()],
      pendingIntentSubmissions: [...this.pendingIntentSubmissions.entries()],
      disclosures: [...this.disclosures.entries()],
      fundingUpdates: [...this.fundingUpdates.entries()],
      liquidationAutomationJobs: [...this.liquidationAutomationJobs.entries()],
      batchExecutionRuns: retainedBatchExecutionRuns([...this.batchExecutionRuns.entries()]),
      intents: [...this.intents.entries()],
      liquidations: [...this.liquidations.entries()],
      marginCommitments: [...this.marginCommitments],
      markets: [...this.markets.entries()],
      marketSettlementVolumes: [...this.marketSettlementVolumes.entries()],
      orderLifecycle: [...this.orderLifecycle.entries()],
      pendingAssetDeposits: [...this.pendingAssetDeposits.entries()],
      positionCloses: [...this.positionCloses.entries()],
      positionCommitments: [...this.positionCommitments],
      positionLifecycle: [...this.positionLifecycle.entries()],
      privateMatchIntents: [...this.privateMatchIntents.entries()],
      proofs: [...this.proofs],
      residualOrders: [...this.residualOrders.entries()],
      settlements: [...this.settlements.entries()],
      spentNullifiers: [...this.spentNullifiers],
      withdrawals: [...this.withdrawals.entries()],
    };

    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    const descriptor = openSync(tempPath, "wx", 0o600);
    try {
      try {
        writeFileSync(descriptor, JSON.stringify(snapshot, bigintReplacer, 2));
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      renameSync(tempPath, this.path);
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); }
      finally { closeSync(directoryDescriptor); }
    } finally { rmSync(tempPath, { force: true }); }
  }
}

function parseSnapshot(raw: string): ProtocolStoreSnapshot {
  return JSON.parse(raw, bigintReviver) as ProtocolStoreSnapshot;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __pnlxBigInt: value.toString() } : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__pnlxBigInt" in value &&
    typeof (value as { __pnlxBigInt: unknown }).__pnlxBigInt === "string"
  ) {
    return BigInt((value as { __pnlxBigInt: string }).__pnlxBigInt);
  }
  return value;
}
