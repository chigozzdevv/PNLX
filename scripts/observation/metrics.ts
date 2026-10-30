import { MongoClient } from "mongodb";

const PHASES = ["oracle", "maker-liquidity", "matcher", "proving", "batch-settlement", "settlement-commit", "maker-finalize"] as const;
export interface PublicRunTiming {
  runId: string;
  batchId?: string;
  status?: "failed" | "running" | "settled" | "skipped";
  settlementDigest?: string;
  startedAt: number;
  completedAt?: number;
  phaseTimestamps: Partial<Record<typeof PHASES[number], number>>;
}

/** Deliberate allowlist: batch payloads may also contain private settlement recovery material. */
export function publicRunTiming(input: unknown, allowed: Set<string>): PublicRunTiming | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, any>;
  if (typeof record.runId !== "string" || !allowed.has(record.runId.toLowerCase()) || !validTime(record.startedAt)) return undefined;
  const phaseTimestamps: PublicRunTiming["phaseTimestamps"] = {};
  for (const phase of PHASES) if (validTime(record.phaseTimestamps?.[phase])) phaseTimestamps[phase] = record.phaseTimestamps[phase];
  return { runId: record.runId, startedAt: record.startedAt,
    ...(typeof record.batchId === "string" ? { batchId: record.batchId } : {}),
    ...(["failed", "running", "settled", "skipped"].includes(record.status) ? { status: record.status } : {}),
    ...(typeof record.settlementDigest === "string" && /^0x[0-9a-f]{64}$/i.test(record.settlementDigest) ? { settlementDigest: record.settlementDigest } : {}),
    ...(validTime(record.completedAt) ? { completedAt: record.completedAt } : {}), phaseTimestamps };
}
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

/** Read only the currently committed checkpoint; never instantiate a protocol writer. */
export async function readExecutionRuns(runIds: string[]): Promise<PublicRunTiming[]> {
  const ids = [...new Set(runIds.filter((id) => /^0x[0-9a-f]{64}$/i.test(id)))];
  if (!ids.length || !process.env.MONGODB_URI) return [];
  const allowed = new Set(ids.map((id) => id.toLowerCase()));
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8_000 });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DATABASE || "pnlx");
    const base = process.env.MONGODB_PROTOCOL_COLLECTION || "protocol_state";
    const checkpoint = await db.collection<{ _id: string; snapshotId?: string; format?: string; payload?: string }>(base).findOne({ _id: "default" });
    if (!checkpoint) return [];
    let entries: unknown[] = [];
    if (checkpoint.format === "normalized-v1" && checkpoint.snapshotId) {
      const records = await db.collection(`${base}_batch_runs`).find({ documentId: checkpoint._id,
        snapshotId: checkpoint.snapshotId, recordKey: { $in: ids } }, { projection: { payload: 1, _id: 0 } }).toArray();
      entries = records.map((record) => JSON.parse(record.payload));
    } else if (checkpoint.payload) entries = JSON.parse(checkpoint.payload).batchExecutionRuns ?? [];
    return entries.map((entry) => publicRunTiming(Array.isArray(entry) ? entry[1] : entry, allowed))
      .filter((value): value is PublicRunTiming => value !== undefined);
  } finally { await client.close(); }
}
