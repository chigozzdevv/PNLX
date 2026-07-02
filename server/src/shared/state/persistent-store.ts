import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  Hex,
  IntentRecord,
  LiquidationAutomationJobRecord,
  LiquidationRecord,
  MarketConfig,
  OrderLifecycleRecord,
  PendingAssetDepositRecord,
  PositionCloseRecord,
  PositionLifecycleRecord,
  ProofMeta,
  ResidualOrderRecord,
  WithdrawalRecord,
} from "@pnlx/protocol-types";
import { ProtocolStore } from "@/shared/state/store";

interface ProtocolStoreSnapshot {
  accountEvents: [Hex, AccountEventRecord][];
  accountEncryptionKeys: [Hex, AccountEncryptionKeyRecord][];
  batchExecutionRuns: [Hex, BatchExecutionRunRecord][];
  conditionalCloses: [Hex, ConditionalOrderRecord][];
  conditionalOrders: [Hex, ConditionalOrderCommitment][];
  disclosures: [Hex, DisclosureRecord][];
  fundingUpdates: [string, FundingUpdateRecord][];
  intents: [string, IntentRecord][];
  liquidationAutomationJobs: [Hex, LiquidationAutomationJobRecord][];
  liquidations: [Hex, LiquidationRecord][];
  marginCommitments: Hex[];
  markets: [string, MarketConfig][];
  orderLifecycle: [Hex, OrderLifecycleRecord][];
  pendingAssetDeposits: [Hex, PendingAssetDepositRecord][];
  positionCloses: [Hex, PositionCloseRecord][];
  positionCommitments: Hex[];
  positionLifecycle: [Hex, PositionLifecycleRecord][];
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

  override addPendingAssetDeposit(record: PendingAssetDepositRecord): void {
    this.persist(() => super.addPendingAssetDeposit(record));
  }

  override finalizePendingAssetDeposit(
    commitment: Hex,
    relay: { relayId: Hex; txHash?: Hex },
  ): PendingAssetDepositRecord {
    return this.persist(() => super.finalizePendingAssetDeposit(commitment, relay));
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

  override addLiquidationAutomationJob(record: LiquidationAutomationJobRecord): void {
    this.persist(() => super.addLiquidationAutomationJob(record));
  }

  override updateLiquidationAutomationJob(record: LiquidationAutomationJobRecord): void {
    this.persist(() => super.updateLiquidationAutomationJob(record));
  }

  override addBatchExecutionRun(record: BatchExecutionRunRecord): void {
    this.persist(() => super.addBatchExecutionRun(record));
  }

  override addIntent(record: IntentRecord): void {
    this.persist(() => super.addIntent(record));
  }

  override cancelOrder(intentCommitment: Hex): OrderLifecycleRecord {
    return this.persist(() => super.cancelOrder(intentCommitment));
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
  ): void {
    this.persist(() => super.addSettlement(settlement, positionOpenings, residualOrders, accountEvents));
  }

  override addPositionOpening(record: PositionLifecycleRecord): void {
    this.persist(() => super.addPositionOpening(record));
  }

  override addResidualOrder(record: ResidualOrderRecord): void {
    this.persist(() => super.addResidualOrder(record));
  }

  override addLiquidation(record: LiquidationRecord): void {
    this.persist(() => super.addLiquidation(record));
  }

  override addConditionalOrder(record: ConditionalOrderCommitment): void {
    this.persist(() => super.addConditionalOrder(record));
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

    const snapshot = parseSnapshot(readFileSync(this.path, "utf8"));
    this.marginCommitments.clear();
    this.positionCommitments.clear();
    this.spentNullifiers.clear();
    this.intents.clear();
    this.residualOrders.clear();
    this.orderLifecycle.clear();
    this.positionLifecycle.clear();
    this.markets.clear();
    this.settlements.clear();
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
        ownerCommitmentField: value.ownerCommitmentField ?? "0x0",
      });
    }
    for (const [key, value] of snapshot.residualOrders ?? []) this.residualOrders.set(key, value);
    for (const [key, value] of snapshot.orderLifecycle ?? []) this.orderLifecycle.set(key, value);
    for (const [key, value] of snapshot.positionLifecycle ?? []) this.positionLifecycle.set(key, value);
    for (const [key, value] of snapshot.markets) this.markets.set(key, value);
    for (const [key, value] of snapshot.settlements) {
      this.settlements.set(key, {
        ...value,
        matchTranscriptDigest: value.matchTranscriptDigest ?? "0x0",
        marginChangeCommitments: value.marginChangeCommitments ?? [],
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
    for (const [key, value] of snapshot.batchExecutionRuns ?? []) this.batchExecutionRuns.set(key, value);
    for (const [key, value] of snapshot.withdrawals) this.withdrawals.set(key, value);
    for (const value of snapshot.proofs) this.proofs.add(value);
  }

  private save(): void {
    const snapshot: ProtocolStoreSnapshot = {
      accountEvents: [...this.accountEvents.entries()],
      accountEncryptionKeys: [...this.accountEncryptionKeys.entries()],
      conditionalCloses: [...this.conditionalCloses.entries()],
      conditionalOrders: [...this.conditionalOrders.entries()],
      disclosures: [...this.disclosures.entries()],
      fundingUpdates: [...this.fundingUpdates.entries()],
      liquidationAutomationJobs: [...this.liquidationAutomationJobs.entries()],
      batchExecutionRuns: [...this.batchExecutionRuns.entries()],
      intents: [...this.intents.entries()],
      liquidations: [...this.liquidations.entries()],
      marginCommitments: [...this.marginCommitments],
      markets: [...this.markets.entries()],
      orderLifecycle: [...this.orderLifecycle.entries()],
      pendingAssetDeposits: [...this.pendingAssetDeposits.entries()],
      positionCloses: [...this.positionCloses.entries()],
      positionCommitments: [...this.positionCommitments],
      positionLifecycle: [...this.positionLifecycle.entries()],
      proofs: [...this.proofs],
      residualOrders: [...this.residualOrders.entries()],
      settlements: [...this.settlements.entries()],
      spentNullifiers: [...this.spentNullifiers],
      withdrawals: [...this.withdrawals.entries()],
    };

    mkdirSync(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, JSON.stringify(snapshot, bigintReplacer, 2));
    renameSync(tempPath, this.path);
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
