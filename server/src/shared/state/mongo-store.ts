import { MongoClient, type Collection } from "mongodb";
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
  PrivateMatchIntent,
  ProofMeta,
  ResidualOrderRecord,
  WithdrawalRecord,
} from "@pnlx/protocol-types";
import { ProtocolStore } from "@/shared/state/store";
import {
  applyProtocolStoreSnapshot,
  parseProtocolSnapshot,
  snapshotProtocolStore,
  stringifyProtocolSnapshot,
} from "@/shared/state/protocol-snapshot";

interface MongoProtocolStoreDocument {
  _id: string;
  payload: string;
  updatedAt: Date;
}

export interface MongoProtocolStoreOptions {
  collection?: string;
  database?: string;
  documentId?: string;
  uri: string;
}

export class MongoProtocolStore extends ProtocolStore {
  private pendingSave: Promise<void> = Promise.resolve();
  private saveDepth = 0;

  private constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<MongoProtocolStoreDocument>,
    private readonly documentId: string,
  ) {
    super();
  }

  static async connect(options: MongoProtocolStoreOptions): Promise<MongoProtocolStore> {
    const client = new MongoClient(options.uri);
    await client.connect();
    const db = client.db(options.database || "pnlx");
    const collection = db.collection<MongoProtocolStoreDocument>(options.collection || "protocol_state");
    const store = new MongoProtocolStore(client, collection, options.documentId || "default");
    await store.load();
    return store;
  }

  async flush(): Promise<void> {
    await this.pendingSave;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.client.close();
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

  override addIntent(record: IntentRecord, privateMatchIntent?: PrivateMatchIntent): void {
    this.persist(() => super.addIntent(record, privateMatchIntent));
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

  private persist<T>(operation: () => T): T {
    this.saveDepth += 1;
    try {
      const result = operation();
      if (this.saveDepth === 1) this.queueSave();
      return result;
    } finally {
      this.saveDepth -= 1;
    }
  }

  private async load(): Promise<void> {
    const document = await this.collection.findOne({ _id: this.documentId });
    if (!document?.payload) return;
    applyProtocolStoreSnapshot(this, parseProtocolSnapshot(document.payload));
  }

  private queueSave(): void {
    const payload = stringifyProtocolSnapshot(snapshotProtocolStore(this));
    this.pendingSave = this.pendingSave.then(async () => {
      await this.collection.updateOne(
        { _id: this.documentId },
        {
          $set: {
            payload,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    });
    this.pendingSave.catch((error) => {
      console.error("failed to persist protocol state to MongoDB", error);
    });
  }
}
