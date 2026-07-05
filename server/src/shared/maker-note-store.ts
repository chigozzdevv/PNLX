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
      await collection.deleteMany({ namespace: config.namespace });
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
    await collection.deleteMany({
      namespace: config.namespace,
      commitment: { $nin: commitments },
    });
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
