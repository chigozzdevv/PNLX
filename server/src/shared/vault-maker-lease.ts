import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

const LEASE_MS = 120_000;

export async function withVaultMakerLease(
  uri: string,
  database: string,
  id: string,
  work: (assertLease: () => void) => Promise<void>,
): Promise<void> {
  const client = new MongoClient(uri);
  const owner = randomUUID();
  let lost = false;
  await client.connect();
  const locks = client.db(database).collection<{ _id: string; owner: string; expiresAt: number }>("vault_maker_leases");
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    try {
      const now = Date.now();
      const acquired = await locks.findOneAndUpdate(
        { _id: id, expiresAt: { $lt: now } },
        { $set: { owner, expiresAt: now + LEASE_MS } },
        { upsert: true, returnDocument: "after" },
      );
      if (acquired?.owner !== owner) throw new Error("vault maker manager is already running");
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new Error("vault maker manager is already running");
      throw error;
    }
    timer = setInterval(() => {
      void locks.updateOne({ _id: id, owner }, { $set: { expiresAt: Date.now() + LEASE_MS } })
        .then((result) => { if (result.matchedCount !== 1) lost = true; })
        .catch(() => { lost = true; });
    }, LEASE_MS / 4);
    await work(() => { if (lost) throw new Error("vault maker manager lost its lease"); });
  } finally {
    if (timer) clearInterval(timer);
    await locks.updateOne({ _id: id, owner }, { $set: { expiresAt: 0 } });
    await client.close();
  }
}
