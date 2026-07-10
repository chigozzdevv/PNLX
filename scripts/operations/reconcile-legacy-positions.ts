import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fieldMerkleRoot } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import { loadEnv } from "../../server/src/config/env";
import {
  reconcileLegacyPositionDocuments,
  type LegacyPositionAuditDocument,
} from "../../server/src/shared/state/legacy-position-repository";
import { MongoProtocolStore } from "../../server/src/shared/state/mongo-store";

interface LegacyPositionRecord {
  classification: "position-opening" | "position-close-output";
  commitment: Hex;
  lifecycleEvidence?: {
    positionNullifier: Hex;
    status: "spent-by-position-close";
    txHash: string;
  };
  ordinal: number;
  sourceFunction: "settle" | "settle_manual";
  sourceTxHash: string;
}

interface LegacyPositionManifest {
  documentId: string;
  network: string;
  positionStateContract: string;
  reconciledAt: string;
  reconciledRoot: Hex;
  records: LegacyPositionRecord[];
  schema: "pnlx-legacy-position-reconciliation-v1";
}

const manifestPath = join(
  process.cwd(),
  "deployments/testnet-legacy-position-reconciliation.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as LegacyPositionManifest;
validateManifest(manifest);

const env = loadEnv();
if (env.stellarNetwork !== manifest.network || env.stellarNetwork !== manifest.documentId) {
  throw new Error("legacy position manifest does not match the configured network");
}

const store = await MongoProtocolStore.connect({
  collection: env.mongodbCollection,
  database: env.mongodbDatabase,
  documentId: env.stellarNetwork,
  uri: env.mongodbUri,
});
try {
  const missing = manifest.records
    .map((record) => record.commitment)
    .filter((commitment) => !store.positionCommitments.has(commitment));
  if (missing.length > 0) {
    throw new Error(`live protocol state is missing ${missing.length} reconciled commitments`);
  }
} finally {
  await store.close();
}

const result = await reconcileLegacyPositionDocuments({
  collection: `${env.mongodbCollection}_legacy_positions`,
  database: env.mongodbDatabase,
  documents: manifest.records.map((record) => legacyDocument(manifest, record)),
  uri: env.mongodbUri,
});
console.log(JSON.stringify({
  ...result,
  reconciledRoot: manifest.reconciledRoot,
}, null, 2));

function validateManifest(value: LegacyPositionManifest): void {
  if (value.schema !== "pnlx-legacy-position-reconciliation-v1") {
    throw new Error("unsupported legacy position manifest schema");
  }
  if (value.records.length !== 13) {
    throw new Error(`legacy position manifest must contain 13 records; received ${value.records.length}`);
  }
  if (JSON.stringify(value).toLowerCase().includes("owner")) {
    throw new Error("legacy position manifest must not contain inferred owner data");
  }
  const seen = new Set<string>();
  for (const [index, record] of value.records.entries()) {
    if (record.ordinal !== index) throw new Error("legacy position ordinals must be contiguous");
    if (!/^0x[0-9a-f]{64}$/.test(record.commitment)) {
      throw new Error(`invalid legacy position commitment at ordinal ${index}`);
    }
    if (seen.has(record.commitment)) throw new Error("duplicate legacy position commitment");
    seen.add(record.commitment);
  }
  const root = fieldMerkleRoot(value.records.map((record) => record.commitment));
  if (root !== value.reconciledRoot) {
    throw new Error(`legacy position root mismatch: expected ${value.reconciledRoot}, received ${root}`);
  }
}

function legacyDocument(
  manifest: LegacyPositionManifest,
  record: LegacyPositionRecord,
): LegacyPositionAuditDocument {
  return {
    _id: `${manifest.documentId}:${record.commitment}`,
    ...record,
    documentId: manifest.documentId,
    manifestSchema: manifest.schema,
    network: manifest.network,
    positionStateContract: manifest.positionStateContract,
    reconciledAt: manifest.reconciledAt,
    reconciledRoot: manifest.reconciledRoot,
  };
}
