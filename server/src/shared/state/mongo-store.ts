import { randomUUID } from "node:crypto";
import { MongoClient, type Collection, type Db } from "mongodb";
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
import { ProtocolStore } from "@/shared/state/store";
import {
  applyProtocolStoreSnapshot,
  parseProtocolSnapshot,
  snapshotProtocolStore,
} from "@/shared/state/protocol-snapshot";
import {
  NORMALIZED_PROTOCOL_FORMAT,
  StaleProtocolStateError,
  backupLegacyProtocolSnapshot,
  commitProtocolCheckpoint,
  deleteNormalizedSnapshot,
  ensureNormalizedSnapshotIndexes,
  normalizedSnapshotCounts,
  legacyNormalizedSnapshotPositionRoot,
  normalizedSnapshotPositionRoot,
  pruneNormalizedSnapshots,
  readNormalizedSnapshot,
  recordProtocolCheckpointHistory,
  writeNormalizedSnapshot,
  type ProtocolCheckpointDocument,
} from "@/shared/state/mongo-normalized-snapshot";

export interface ProtocolPersistenceStatus {
  error?: string;
  format: "empty" | "legacy-json" | typeof NORMALIZED_PROTOCOL_FORMAT;
  healthy: boolean;
  version: number;
}

export interface MongoProtocolStoreOptions {
  collection?: string;
  database?: string;
  documentId?: string;
  ensureIndexes?: boolean;
  positionTree?: "canonical-append" | "legacy-sorted";
  uri: string;
}

export class MongoProtocolStore extends ProtocolStore {
  private format: ProtocolPersistenceStatus["format"] = "empty";
  private legacyPayload?: string;
  private pendingSave: Promise<void> = Promise.resolve();
  private persistenceFailure?: Error;
  private saveDepth = 0;
  private version = 0;

  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly collection: Collection<ProtocolCheckpointDocument>,
    private readonly baseCollection: string,
    private readonly documentId: string,
    private readonly positionTree: "canonical-append" | "legacy-sorted",
  ) {
    super();
  }

  static async connect(options: MongoProtocolStoreOptions): Promise<MongoProtocolStore> {
    const client = new MongoClient(options.uri);
    await client.connect();
    const db = client.db(options.database || "pnlx");
    const baseCollection = options.collection || "protocol_state";
    const collection = db.collection<ProtocolCheckpointDocument>(baseCollection);
    const store = new MongoProtocolStore(
      client,
      db,
      collection,
      baseCollection,
      options.documentId || "default",
      options.positionTree ?? "canonical-append",
    );
    await store.load();
    if (options.ensureIndexes) {
      await ensureNormalizedSnapshotIndexes(db, baseCollection);
    }
    return store;
  }

  async flush(): Promise<void> {
    await this.pendingSave;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.client.close();
  }

  async migrate(): Promise<ProtocolPersistenceStatus> {
    this.assertWritable();
    if (this.format === NORMALIZED_PROTOCOL_FORMAT) return this.persistenceStatus();
    this.queueSave();
    await this.flush();
    return this.persistenceStatus();
  }

  persistenceStatus(): ProtocolPersistenceStatus {
    return {
      ...(this.persistenceFailure ? { error: this.persistenceFailure.message } : {}),
      format: this.format,
      healthy: !this.persistenceFailure,
      version: this.version,
    };
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

  override addFundingPremiumSamples(records: FundingPremiumSampleRecord[]): void {
    this.persist(() => super.addFundingPremiumSamples(records));
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

  override upsertBatchExecutionRun(record: BatchExecutionRunRecord): void {
    this.persist(() => super.upsertBatchExecutionRun(record));
  }

  override addIntent(record: IntentRecord, privateMatchIntent?: PrivateMatchIntent): void {
    this.persist(() => super.addIntent(record, privateMatchIntent));
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
    this.assertWritable();
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
    if (!document) return;
    this.version = parseVersion(document.version);
    if (document.format === NORMALIZED_PROTOCOL_FORMAT) {
      applyProtocolStoreSnapshot(
        this,
        await readNormalizedSnapshot(
          this.db,
          this.baseCollection,
          document,
          this.positionTree === "legacy-sorted"
            ? legacyNormalizedSnapshotPositionRoot
            : normalizedSnapshotPositionRoot,
        ),
      );
      this.format = NORMALIZED_PROTOCOL_FORMAT;
      return;
    }
    if (!document.payload) {
      throw new Error(`protocol checkpoint ${this.documentId} has no readable state`);
    }
    this.legacyPayload = document.payload;
    applyProtocolStoreSnapshot(this, parseProtocolSnapshot(document.payload));
    this.format = "legacy-json";
  }

  private queueSave(): void {
    const snapshot = snapshotProtocolStore(this);
    const operation = this.pendingSave.then(() => this.saveSnapshot(snapshot));
    this.pendingSave = operation;
    void operation.catch((error) => {
      const failure = asError(error);
      this.persistenceFailure ??= failure;
      console.error("failed to persist protocol state to MongoDB", failure);
    });
  }

  private async saveSnapshot(snapshot: ReturnType<typeof snapshotProtocolStore>): Promise<void> {
    const expectedVersion = this.version;
    const nextVersion = expectedVersion + 1;
    const snapshotId = randomUUID();
    const counts = normalizedSnapshotCounts(snapshot);
    const positionRoot = normalizedSnapshotPositionRoot(snapshot);

    await writeNormalizedSnapshot(
      this.db,
      this.baseCollection,
      this.documentId,
      snapshotId,
      nextVersion,
      snapshot,
    );
    try {
      if (this.legacyPayload) {
        await backupLegacyProtocolSnapshot(
          this.db,
          this.baseCollection,
          this.documentId,
          this.legacyPayload,
        );
      }
      const committedAt = new Date();
      const checkpoint = {
        _id: this.documentId,
        counts,
        format: NORMALIZED_PROTOCOL_FORMAT,
        positionRoot,
        snapshotId,
        updatedAt: committedAt,
        version: nextVersion,
      } as const;
      const committed = await commitProtocolCheckpoint(
        this.collection,
        checkpoint,
        expectedVersion,
      );
      if (!committed) throw new StaleProtocolStateError(expectedVersion);

      this.format = NORMALIZED_PROTOCOL_FORMAT;
      this.legacyPayload = undefined;
      this.version = nextVersion;
      await Promise.all([
        recordProtocolCheckpointHistory(this.db, this.baseCollection, {
          _id: snapshotId,
          committedAt,
          counts,
          documentId: this.documentId,
          format: NORMALIZED_PROTOCOL_FORMAT,
          positionRoot,
          snapshotId,
          version: nextVersion,
        }),
        pruneNormalizedSnapshots(
          this.db,
          this.baseCollection,
          this.documentId,
          nextVersion,
        ),
      ]).catch((error) => {
        console.error("failed to maintain protocol snapshot history", error);
      });
    } catch (error) {
      await deleteNormalizedSnapshot(
        this.db,
        this.baseCollection,
        this.documentId,
        snapshotId,
      ).catch(() => undefined);
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.persistenceFailure) {
      throw new Error(`protocol persistence is unhealthy: ${this.persistenceFailure.message}`);
    }
  }
}

function parseVersion(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("protocol checkpoint version is invalid");
  }
  return Number(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
