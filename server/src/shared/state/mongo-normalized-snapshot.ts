import { createHash } from "node:crypto";
import { fieldMerkleRoot } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import type { Collection, Db, Filter } from "mongodb";
import {
  bigintReplacer,
  bigintReviver,
  type ProtocolStoreSnapshot,
} from "@/shared/state/protocol-snapshot";

export const NORMALIZED_PROTOCOL_FORMAT = "normalized-v1";
export const NORMALIZED_SNAPSHOT_RETENTION = 10;

export const NORMALIZED_SNAPSHOT_FIELDS = [
  ["accountEvents", "account_events"],
  ["accountEncryptionKeys", "account_keys"],
  ["batchExecutionRuns", "batch_runs"],
  ["conditionalCloses", "conditional_closes"],
  ["conditionalOrders", "conditional_orders"],
  ["disclosures", "disclosures"],
  ["fundingUpdates", "funding_updates"],
  ["fundingPremiumSamples", "funding_premium_samples"],
  ["intents", "intents"],
  ["liquidationAutomationJobs", "liquidation_jobs"],
  ["liquidations", "liquidations"],
  ["marginCommitments", "margin_commitments"],
  ["markets", "markets"],
  ["orderLifecycle", "orders"],
  ["pendingAssetDeposits", "pending_deposits"],
  ["positionCloses", "position_closes"],
  ["positionCommitments", "position_commitments"],
  ["positionLifecycle", "positions"],
  ["privateMatchIntents", "private_match_intents"],
  ["proofs", "proofs"],
  ["residualOrders", "residual_orders"],
  ["settlements", "settlements"],
  ["spentNullifiers", "spent_nullifiers"],
  ["withdrawals", "withdrawals"],
] as const satisfies readonly (readonly [keyof ProtocolStoreSnapshot, string])[];

export type NormalizedSnapshotField = typeof NORMALIZED_SNAPSHOT_FIELDS[number][0];
export type ProtocolSnapshotCounts = Record<NormalizedSnapshotField, number>;

export interface ProtocolCheckpointDocument {
  _id: string;
  counts?: Partial<ProtocolSnapshotCounts>;
  format?: string;
  payload?: string;
  positionRoot?: Hex;
  snapshotId?: string;
  updatedAt: Date;
  version?: number;
}

export interface NormalizedSnapshotRecord {
  _id: string;
  documentId: string;
  ordinal: number;
  payload: string;
  recordKey: string;
  snapshotId: string;
  version: number;
}

export interface ProtocolCheckpointHistoryDocument {
  _id: string;
  committedAt: Date;
  counts: ProtocolSnapshotCounts;
  documentId: string;
  format: typeof NORMALIZED_PROTOCOL_FORMAT;
  positionRoot: Hex;
  snapshotId: string;
  version: number;
}

export interface LegacyProtocolSnapshotBackupDocument {
  _id: string;
  backedUpAt: Date;
  documentId: string;
  payload: string;
  payloadDigest: Hex;
}

export class StaleProtocolStateError extends Error {
  constructor(readonly expectedVersion: number) {
    super(`stale protocol state writer: expected Mongo version ${expectedVersion}`);
    this.name = "StaleProtocolStateError";
  }
}

export function normalizedCollectionName(baseCollection: string, suffix: string): string {
  return `${baseCollection}_${suffix}`;
}

export function normalizedSnapshotCounts(snapshot: ProtocolStoreSnapshot): ProtocolSnapshotCounts {
  return Object.fromEntries(
    NORMALIZED_SNAPSHOT_FIELDS.map(([field]) => [field, (snapshot[field] ?? []).length]),
  ) as ProtocolSnapshotCounts;
}

export function normalizedSnapshotPositionRoot(snapshot: ProtocolStoreSnapshot): Hex {
  return fieldMerkleRoot(snapshot.positionCommitments);
}

export function normalizedSnapshotRecords(
  documentId: string,
  snapshotId: string,
  version: number,
  field: NormalizedSnapshotField,
  entries: ProtocolStoreSnapshot[NormalizedSnapshotField],
): NormalizedSnapshotRecord[] {
  return (entries ?? []).map((entry, ordinal) => {
    const payload = JSON.stringify(entry, bigintReplacer);
    const recordKey = snapshotRecordKey(entry, payload);
    return {
      _id: snapshotRecordId(documentId, snapshotId, field, ordinal, recordKey),
      documentId,
      ordinal,
      payload,
      recordKey,
      snapshotId,
      version,
    };
  });
}

export function normalizedSnapshotFromRecords(
  records: Partial<Record<NormalizedSnapshotField, NormalizedSnapshotRecord[]>>,
  expectedCounts: Partial<ProtocolSnapshotCounts>,
): ProtocolStoreSnapshot {
  const snapshot: Partial<ProtocolStoreSnapshot> = {};
  for (const [field] of NORMALIZED_SNAPSHOT_FIELDS) {
    const values = [...(records[field] ?? [])].sort((left, right) => left.ordinal - right.ordinal);
    const expected = expectedCounts[field];
    if (!Number.isSafeInteger(expected) || expected! < 0) {
      throw new Error(`normalized protocol snapshot is missing count for ${field}`);
    }
    if (values.length !== expected) {
      throw new Error(
        `normalized protocol snapshot count mismatch for ${field}: expected ${expected}, received ${values.length}`,
      );
    }
    for (let ordinal = 0; ordinal < values.length; ordinal += 1) {
      if (values[ordinal].ordinal !== ordinal) {
        throw new Error(`normalized protocol snapshot ordinal mismatch for ${field}`);
      }
    }
    snapshot[field] = values.map((record) => JSON.parse(record.payload, bigintReviver)) as never;
  }
  return snapshot as ProtocolStoreSnapshot;
}

export async function ensureNormalizedSnapshotIndexes(db: Db, baseCollection: string): Promise<void> {
  await Promise.all([
    ...NORMALIZED_SNAPSHOT_FIELDS.map(([, suffix]) =>
      db.collection(normalizedCollectionName(baseCollection, suffix)).createIndex(
        { documentId: 1, snapshotId: 1, ordinal: 1 },
        { name: "snapshot_entries" },
      )
    ),
    db.collection(normalizedCollectionName(baseCollection, "history")).createIndex(
      { documentId: 1, version: -1 },
      { name: "document_versions" },
    ),
  ]);
}

export async function writeNormalizedSnapshot(
  db: Db,
  baseCollection: string,
  documentId: string,
  snapshotId: string,
  version: number,
  snapshot: ProtocolStoreSnapshot,
): Promise<void> {
  await Promise.all(
    NORMALIZED_SNAPSHOT_FIELDS.map(async ([field, suffix]) => {
      const records = normalizedSnapshotRecords(
        documentId,
        snapshotId,
        version,
        field,
        snapshot[field],
      );
      if (records.length === 0) return;
      await db.collection<NormalizedSnapshotRecord>(
        normalizedCollectionName(baseCollection, suffix),
      ).insertMany(records, { ordered: false });
    }),
  );
}

export async function readNormalizedSnapshot(
  db: Db,
  baseCollection: string,
  checkpoint: ProtocolCheckpointDocument,
): Promise<ProtocolStoreSnapshot> {
  if (
    checkpoint.format !== NORMALIZED_PROTOCOL_FORMAT ||
    !checkpoint.snapshotId ||
    !Number.isSafeInteger(checkpoint.version) ||
    checkpoint.version! <= 0 ||
    !checkpoint.counts ||
    !checkpoint.positionRoot
  ) {
    throw new Error("normalized protocol checkpoint is incomplete");
  }

  const entries = Object.fromEntries(
    await Promise.all(
      NORMALIZED_SNAPSHOT_FIELDS.map(async ([field, suffix]) => {
        const records = await db.collection<NormalizedSnapshotRecord>(
          normalizedCollectionName(baseCollection, suffix),
        ).find({
          documentId: checkpoint._id,
          snapshotId: checkpoint.snapshotId,
        }).sort({ ordinal: 1 }).toArray();
        return [field, records] as const;
      }),
    ),
  ) as Record<NormalizedSnapshotField, NormalizedSnapshotRecord[]>;

  const snapshot = normalizedSnapshotFromRecords(entries, {
    ...checkpoint.counts,
    fundingPremiumSamples: checkpoint.counts.fundingPremiumSamples ?? 0,
  });
  const actualRoot = normalizedSnapshotPositionRoot(snapshot);
  if (actualRoot.toLowerCase() !== checkpoint.positionRoot.toLowerCase()) {
    throw new Error(
      `normalized protocol snapshot position root mismatch: expected ${checkpoint.positionRoot}, received ${actualRoot}`,
    );
  }
  return snapshot;
}

export function protocolCheckpointFilter(
  documentId: string,
  expectedVersion: number,
): Filter<ProtocolCheckpointDocument> {
  if (expectedVersion === 0) {
    return {
      _id: documentId,
      $or: [
        { version: 0 },
        { version: { $exists: false } },
      ],
    };
  }
  return { _id: documentId, version: expectedVersion };
}

export async function commitProtocolCheckpoint(
  collection: Pick<Collection<ProtocolCheckpointDocument>, "insertOne" | "updateOne">,
  checkpoint: ProtocolCheckpointDocument & {
    counts: ProtocolSnapshotCounts;
    format: typeof NORMALIZED_PROTOCOL_FORMAT;
    positionRoot: Hex;
    snapshotId: string;
    version: number;
  },
  expectedVersion: number,
): Promise<boolean> {
  const { _id, ...fields } = checkpoint;
  const updated = await collection.updateOne(
    protocolCheckpointFilter(_id, expectedVersion),
    {
      $set: fields,
      $unset: { payload: "" },
    },
  );
  if (updated.matchedCount === 1) return true;
  if (expectedVersion !== 0) return false;

  try {
    await collection.insertOne(checkpoint);
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

export async function deleteNormalizedSnapshot(
  db: Db,
  baseCollection: string,
  documentId: string,
  snapshotId: string,
): Promise<void> {
  await Promise.all(
    NORMALIZED_SNAPSHOT_FIELDS.map(([, suffix]) =>
      db.collection(normalizedCollectionName(baseCollection, suffix)).deleteMany({
        documentId,
        snapshotId,
      })
    ),
  );
}

export async function pruneNormalizedSnapshots(
  db: Db,
  baseCollection: string,
  documentId: string,
  currentVersion: number,
  retention = NORMALIZED_SNAPSHOT_RETENTION,
): Promise<void> {
  const minimumVersion = currentVersion - retention + 1;
  if (minimumVersion <= 1) return;
  await Promise.all(
    NORMALIZED_SNAPSHOT_FIELDS.map(([, suffix]) =>
      db.collection(normalizedCollectionName(baseCollection, suffix)).deleteMany({
        documentId,
        version: { $lt: minimumVersion },
      })
    ),
  );
}

export async function recordProtocolCheckpointHistory(
  db: Db,
  baseCollection: string,
  checkpoint: ProtocolCheckpointHistoryDocument,
): Promise<void> {
  await db.collection<ProtocolCheckpointHistoryDocument>(
    normalizedCollectionName(baseCollection, "history"),
  ).updateOne(
    { _id: checkpoint._id },
    { $setOnInsert: checkpoint },
    { upsert: true },
  );
}

export async function backupLegacyProtocolSnapshot(
  db: Db,
  baseCollection: string,
  documentId: string,
  payload: string,
): Promise<void> {
  const digest = sha256Hex(payload);
  const backup: LegacyProtocolSnapshotBackupDocument = {
    _id: `${documentId}:${digest.slice(2)}`,
    backedUpAt: new Date(),
    documentId,
    payload,
    payloadDigest: digest,
  };
  await db.collection<LegacyProtocolSnapshotBackupDocument>(
    normalizedCollectionName(baseCollection, "legacy_backups"),
  ).updateOne(
    { _id: backup._id },
    { $setOnInsert: backup },
    { upsert: true },
  );
}

function snapshotRecordKey(entry: unknown, payload: string): string {
  if (typeof entry === "string") return entry;
  if (
    Array.isArray(entry) &&
    entry.length === 2 &&
    (typeof entry[0] === "string" || typeof entry[0] === "number")
  ) {
    return String(entry[0]);
  }
  return sha256Hex(payload);
}

function snapshotRecordId(
  documentId: string,
  snapshotId: string,
  field: string,
  ordinal: number,
  recordKey: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([documentId, snapshotId, field, ordinal, recordKey]))
    .digest("hex");
}

function sha256Hex(value: string): Hex {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000,
  );
}
