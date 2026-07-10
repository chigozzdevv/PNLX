import type { Hex } from "@pnlx/protocol-types";
import { MongoClient } from "mongodb";

export interface LegacyPositionAuditDocument {
  _id: string;
  classification: "position-opening" | "position-close-output";
  commitment: Hex;
  documentId: string;
  lifecycleEvidence?: {
    positionNullifier: Hex;
    status: "spent-by-position-close";
    txHash: string;
  };
  manifestSchema: "pnlx-legacy-position-reconciliation-v1";
  network: string;
  ordinal: number;
  positionStateContract: string;
  reconciledAt: string;
  reconciledRoot: Hex;
  sourceFunction: "settle" | "settle_manual";
  sourceTxHash: string;
}

export interface ReconcileLegacyPositionOptions {
  collection: string;
  database: string;
  documents: LegacyPositionAuditDocument[];
  uri: string;
}

export async function reconcileLegacyPositionDocuments(
  options: ReconcileLegacyPositionOptions,
): Promise<{ collection: string; inserted: number; verified: number }> {
  const client = new MongoClient(options.uri);
  await client.connect();
  try {
    const collection = client.db(options.database).collection<LegacyPositionAuditDocument>(
      options.collection,
    );
    await collection.createIndex(
      { documentId: 1, commitment: 1 },
      { name: "legacy_commitment", unique: true },
    );

    let inserted = 0;
    let verified = 0;
    for (const document of options.documents) {
      const result = await collection.updateOne(
        { _id: document._id },
        { $setOnInsert: document },
        { upsert: true },
      );
      if (result.upsertedCount === 1) inserted += 1;
      const stored = await collection.findOne({ _id: document._id });
      if (!stored || canonicalJson(stored) !== canonicalJson(document)) {
        throw new Error(`legacy position evidence conflict for ${document.commitment}`);
      }
      verified += 1;
    }
    return { collection: collection.collectionName, inserted, verified };
  } finally {
    await client.close();
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
