import { MongoClient } from "mongodb";

export type StoredMakerNoteRecord = Record<string, string | number | undefined>;

interface MakerNoteDocument extends StoredMakerNoteRecord {
  _id: string;
  commitment: string;
  namespace: string;
  updatedAt: number;
}

export function makerNoteStorageLabel(): string {
  return mongoCollectionLabel();
}

export async function readMakerNotes(): Promise<StoredMakerNoteRecord[]> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const documents = await client
      .db(config.database)
      .collection<MakerNoteDocument>(config.collection)
      .find({ namespace: config.namespace })
      .sort({ updatedAt: -1, commitment: 1 })
      .toArray();
    return documents.map(({ _id, namespace, ...note }) => note);
  } finally {
    await client.close();
  }
}

export async function saveMakerNotes(notes: StoredMakerNoteRecord[]): Promise<void> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  const commitments = notes
    .map((note) => String(note.commitment ?? "").trim())
    .filter(Boolean);
  try {
    await client.connect();
    const collection = client.db(config.database).collection<MakerNoteDocument>(config.collection);
    if (commitments.length === 0) {
      return;
    }
    await collection.bulkWrite(
      notes.map((note) => {
        const commitment = String(note.commitment ?? "").trim();
        if (!commitment) throw new Error("maker note commitment is required");
        return {
          updateOne: {
            filter: { _id: makerNoteDocumentId(config.namespace, commitment) },
            update: {
              $set: {
                ...note,
                commitment,
                namespace: config.namespace,
                updatedAt: Number(note.updatedAt ?? Date.now()),
              },
            },
            upsert: true,
          },
        };
      }),
    );
  } finally {
    await client.close();
  }
}

export async function insertPendingMakerNote(note: StoredMakerNoteRecord & { commitment: string }): Promise<void> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const collection = client.db(config.database).collection<MakerNoteDocument>(config.collection);
    if (typeof note.closePositionCommitment === "string") {
      await collection.createIndex(
        { namespace: 1, closePositionCommitment: 1 },
        { unique: true, partialFilterExpression: { closePositionCommitment: { $type: "string" } } },
      );
    }
    const result = await collection.updateOne(
      { _id: makerNoteDocumentId(config.namespace, note.commitment) },
      { $setOnInsert: {
        ...note,
        namespace: config.namespace,
        status: "pending",
        updatedAt: Date.now(),
      } },
      { upsert: true },
    );
    if (result.upsertedCount !== 1) {
      const previous=await collection.findOne({_id:makerNoteDocumentId(config.namespace,note.commitment)});
      const fields=["commitment","amount","assetDigest","blinding","rhoDigest","spendSecretDigest",
        "ownerDigest","closeCommitment","closePositionCommitment","vaultAllocationId","vaultParentCommitment"];
      if (!note.closePositionCommitment || !previous || fields.some((field)=>previous[field]!==note[field])) {
        throw new Error("maker note commitment already exists with conflicting recovery data");
      }
    }
  } finally {
    await client.close();
  }
}

export async function deleteUnsettledPendingMakerCloseOutput(
  commitment: string,
  closePositionCommitment: string,
): Promise<void> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    await client.db(config.database).collection<MakerNoteDocument>(config.collection).deleteOne({
      _id: makerNoteDocumentId(config.namespace, commitment),
      namespace: config.namespace,
      closePositionCommitment,
      status: "pending",
      closeTxHash: { $exists: false },
    });
  } finally {
    await client.close();
  }
}

export async function finalizePendingMakerNote(commitment: string, depositTxHash: string): Promise<void> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const result = await client.db(config.database).collection<MakerNoteDocument>(config.collection).updateOne(
      { _id: makerNoteDocumentId(config.namespace, commitment), namespace: config.namespace, status: "pending" },
      { $set: { depositTxHash, status: "available", updatedAt: Date.now() } },
    );
    if (result.modifiedCount !== 1) throw new Error("pending maker note was not found for finalized deposit");
  } finally {
    await client.close();
  }
}

export async function finalizePendingMakerCloseOutput(
  commitment: string,
  closeTxHash: string,
): Promise<void> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const result = await client.db(config.database).collection<MakerNoteDocument>(config.collection).updateOne(
      { _id: makerNoteDocumentId(config.namespace, commitment), namespace: config.namespace,
        status: "pending", closePositionCommitment: { $type: "string" } },
      { $set: { closeTxHash, status: "draining", updatedAt: Date.now() } },
    );
    if (result.modifiedCount !== 1) {
      const previous=await client.db(config.database).collection<MakerNoteDocument>(config.collection).findOne({
        _id:makerNoteDocumentId(config.namespace,commitment),namespace:config.namespace,
        closePositionCommitment:{$type:"string"},status:{$in:["draining","withdrawing","spent"]},
        closeTxHash,
      });
      if(!previous)throw new Error("pending maker close output was not found");
    }
  } finally {
    await client.close();
  }
}

export async function markRecoveredMakerNoteSettled(commitment: string, settlementTxHash: string): Promise<void> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const collection = client.db(config.database).collection<MakerNoteDocument>(config.collection);
    const result = await collection.updateOne(
      { _id: makerNoteDocumentId(config.namespace, commitment), namespace: config.namespace,
        status: "spent", recoveredAmount: { $type: "string" },
        vaultSettlementTxHash: { $exists: false } },
      { $set: { vaultSettlementTxHash: settlementTxHash, updatedAt: Date.now() } },
    );
    if (result.modifiedCount === 1) return;
    const existing = await collection.findOne({ _id: makerNoteDocumentId(config.namespace, commitment) });
    if (existing?.vaultSettlementTxHash !== settlementTxHash) {
      throw new Error("maker note was not recovered for this vault settlement");
    }
  } finally {
    await client.close();
  }
}

export const markMakerCloseOutputSettled = markRecoveredMakerNoteSettled;

export async function recordZeroMakerCloseOutput(commitment:string,closeTxHash:string):Promise<void> {
  if(!/^(?:0x)?[0-9a-fA-F]{64}$/.test(closeTxHash))throw new Error("confirmed close transaction hash is required");
  const config=requiredMongoConfig();
  const client=new MongoClient(config.uri);
  try {
    await client.connect();
    const collection=client.db(config.database).collection<MakerNoteDocument>(config.collection);
    const result=await collection.updateOne({_id:makerNoteDocumentId(config.namespace,commitment),
      namespace:config.namespace,amount:"0",status:"draining",closeTxHash,
      closePositionCommitment:{$type:"string"}},{$set:{status:"spent",recoveredAmount:"0",updatedAt:Date.now()}});
    if(result.modifiedCount===1)return;
    const current=await collection.findOne({_id:makerNoteDocumentId(config.namespace,commitment),
      namespace:config.namespace,amount:"0",status:"spent",closeTxHash,recoveredAmount:"0"});
    if(!current)throw new Error("confirmed zero-value maker close output was not found");
  }finally{await client.close();}
}

export async function recordMakerNoteRecovery(commitment: string, amount: string): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("recovered amount must be positive");
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const result = await client.db(config.database).collection<MakerNoteDocument>(config.collection).updateOne(
      { _id: makerNoteDocumentId(config.namespace, commitment), namespace: config.namespace,
        status: "withdrawing", amount },
      { $set: { status: "spent", recoveredAmount: amount, updatedAt: Date.now() } },
    );
    if (result.modifiedCount !== 1) throw new Error("maker note changed before recovery could be recorded");
  } finally {
    await client.close();
  }
}

export async function transitionMakerNoteStatus(
  commitment: string,
  from: string,
  to: string,
): Promise<boolean> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const result = await client.db(config.database).collection<MakerNoteDocument>(config.collection).updateOne(
      {
        _id: makerNoteDocumentId(config.namespace, commitment),
        namespace: config.namespace,
        status: from,
      },
      { $set: { status: to, updatedAt: Date.now() } },
    );
    return result.modifiedCount===1;
  } finally {
    await client.close();
  }
}

export async function claimMakerNote(
  commitment: string,
  intentCommitment: string,
  sourceIntentCommitment: string,
  vaultAllocationId?: string,
): Promise<boolean> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const database = client.db(config.database);
    if (vaultAllocationId) {
      const allocation = await database.collection<{ _id: string; namespace: string; status: string }>("vault_maker_allocations").findOne({
        _id: `${config.namespace}:${vaultAllocationId}`,
        namespace: config.namespace,
        status: "outstanding",
      });
      if (!allocation) return false;
    }
    const result = await database.collection<MakerNoteDocument>(config.collection).updateOne(
      { _id: makerNoteDocumentId(config.namespace, commitment), namespace: config.namespace, status: "available",
        ...(vaultAllocationId ? { vaultAllocationId } : {}) },
      { $set: { status: "locked", lockedByIntentCommitment: intentCommitment,
        sourceIntentCommitment, updatedAt: Date.now() } },
    );
    if(result.modifiedCount===1)return true;
    // An exact retry may resume after the atomic claim but before registry submission.
    const existing=await database.collection<MakerNoteDocument>(config.collection).findOne({
      _id:makerNoteDocumentId(config.namespace,commitment),namespace:config.namespace,status:"locked",
      lockedByIntentCommitment:intentCommitment,sourceIntentCommitment,
      ...(vaultAllocationId?{vaultAllocationId}:{}),
    });
    return Boolean(existing);
  } finally {
    await client.close();
  }
}

export async function releaseMakerNote(
  commitment: string,
  intentCommitment: string,
  sourceIntentCommitment: string,
): Promise<boolean> {
  const config = requiredMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const result = await client.db(config.database).collection<MakerNoteDocument>(config.collection).updateOne(
      { _id: makerNoteDocumentId(config.namespace, commitment), namespace: config.namespace, status: "locked",
        lockedByIntentCommitment: intentCommitment, sourceIntentCommitment },
      { $set: { status: "available", updatedAt: Date.now() },
        $unset: { lockedByIntentCommitment: "", sourceIntentCommitment: "" } },
    );
    return result.modifiedCount === 1;
  } finally {
    await client.close();
  }
}

function requiredMongoConfig(): {
  collection: string;
  database: string;
  namespace: string;
  uri: string;
} {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required for maker note storage");
  }

  return {
    collection: "maker_notes",
    database: process.env.MONGODB_DATABASE || "pnlx",
    namespace: process.env.STELLAR_NETWORK || "testnet",
    uri,
  };
}

function mongoCollectionLabel(): string {
  const config = requiredMongoConfig();
  return `${config.database}.${config.collection}:${config.namespace}`;
}

function makerNoteDocumentId(namespace: string, commitment: string): string {
  return `${namespace}:${commitment}`;
}
