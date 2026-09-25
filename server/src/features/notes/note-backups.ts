import { MongoClient, type Db } from "mongodb";
import { ownerCommitment } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import type { ServerEnv } from "@/config/env";
import { clientStorageScope } from "@/features/health/health.controller";
import { authenticatedAddress } from "@/shared/http/auth-context";
import { json, readJson } from "@/shared/http/json";
import type { Router } from "@/shared/http/router";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { RelayerService } from "@/workers/relayer/relayer.service";

interface EncryptedNoteBackup {
  _id: string;
  owner: Hex;
  scope: string;
  commitment: Hex;
  ciphertext: string;
  createdAt: number;
}

const COLLECTION = "private_note_backups";
const OPENING_COLLECTION = "private_position_backups";
const HEX = /^0x[0-9a-fA-F]{64}$/;
const BACKUP_PAGE_SIZE = 250;
const MAX_NOTE_BACKUPS = 10_000;
const RATE_WINDOW_MS = 60_000;
const rateWindows = new Map<string, { count: number; startedAt: number }>();
let activePoolReads = 0;
const waitingPoolReads: Array<() => void> = [];

function rateLimit(key: string, cost: number, limit: number): void {
  const now = Date.now();
  const previous = rateWindows.get(key);
  const next = !previous || now - previous.startedAt >= RATE_WINDOW_MS
    ? { count: cost, startedAt: now }
    : { count: previous.count + cost, startedAt: previous.startedAt };
  if (next.count > limit) throw new Error("Private data request limit reached. Try again shortly.");
  rateWindows.set(key, next);
  if (rateWindows.size > 2_048) {
    for (const [entry, window] of rateWindows) {
      if (now - window.startedAt >= RATE_WINDOW_MS) rateWindows.delete(entry);
    }
  }
}

async function withPoolReadSlot<T>(read: () => Promise<T>): Promise<T> {
  if (activePoolReads >= 4) {
    if (waitingPoolReads.length >= 64) throw new Error("Shielded pool reads are busy. Try again shortly.");
    await new Promise<void>((resolve) => waitingPoolReads.push(resolve));
  } else {
    activePoolReads += 1;
  }
  try {
    return await read();
  } finally {
    const next = waitingPoolReads.shift();
    if (next) next();
    else activePoolReads -= 1;
  }
}

export function registerNoteBackupRoutes(
  router: Router, executor: ExecutorService, env: ServerEnv,
  relayer?: RelayerService, poolId?: string,
): void {
  function account(request: Request): Hex {
    const address = authenticatedAddress(request);
    if (!address) throw new Error("Wallet authentication is required");
    return ownerCommitment(address) as Hex;
  }

  async function withCollection<T>(run: (collection: ReturnType<typeof collectionFor>, db: Db) => Promise<T>): Promise<T> {
    if (!env.mongodbUri) throw new Error("Private note recovery is unavailable");
    const client = new MongoClient(env.mongodbUri);
    try {
      await client.connect();
      return await run(collectionFor(client, env.mongodbDatabase), client.db(env.mongodbDatabase));
    } finally {
      await client.close();
    }
  }

  function currentScope(value: unknown): string {
    const scope = parseScope(value);
    if (scope !== clientStorageScope(env)) throw new Error("Private data network mismatch");
    return scope;
  }

  async function listBackups(owner: Hex, scope: string, cursor: Hex | undefined, name: string) {
    const prefix = `${owner}:${scope}:`;
    const after = cursor ? `${prefix}${cursor}` : prefix;
    const records = await withCollection((_collection, db) => db.collection<EncryptedNoteBackup>(name)
      .find({ owner, scope, _id: cursor ? { $gt: after } : { $gte: after } }, {
        projection: { _id: 0, commitment: 1, ciphertext: 1 },
      })
      .sort({ _id: 1 })
      .limit(BACKUP_PAGE_SIZE + 1)
      .toArray());
    const backups = records.slice(0, BACKUP_PAGE_SIZE);
    return { backups, nextCursor: records.length > BACKUP_PAGE_SIZE ? backups.at(-1)?.commitment : undefined };
  }

  router.add("POST", "/notes/backup", async (request) => {
    const owner = account(request);
    const body = await readJson<Record<string, unknown>>(request);
    const scope = currentScope(body.scope);
    const commitment = parseHex(body.commitment, "commitment");
    const ciphertext = String(body.ciphertext ?? "");
    if (!/^pnlx-note-backup-v1:[A-Za-z0-9_-]{80,8192}$/.test(ciphertext)) {
      throw new Error("Invalid encrypted note backup");
    }
    rateLimit(`note-backup:${owner}`, 1, 300);
    rateLimit("note-backup:global", 1, 1_200);
    const id = `${owner}:${scope}:${commitment}`;
    const stored = await withCollection(async (collection) => {
      const existing = await collection.findOne({ _id: id }, { projection: { ciphertext: 1 } });
      if (existing) return existing;
      const count = await collection.countDocuments({ owner, scope }, { limit: MAX_NOTE_BACKUPS });
      if (count >= MAX_NOTE_BACKUPS) throw new Error("Private note backup capacity reached");
      await collection.updateOne(
        { _id: id },
        { $setOnInsert: { _id: id, owner, scope, commitment, ciphertext, createdAt: Date.now() } },
        { upsert: true },
      );
      return collection.findOne({ _id: id }, { projection: { ciphertext: 1 } });
    });
    if (!stored) throw new Error("Encrypted note backup could not be verified");
    return json({ ciphertext: stored.ciphertext }, 201);
  }, { auth: true });

  router.add("GET", "/notes/backups", async (request) => {
    const owner = account(request);
    const url = new URL(request.url);
    const scope = currentScope(url.searchParams.get("scope"));
    const cursor = url.searchParams.has("cursor") ? parseHex(url.searchParams.get("cursor"), "cursor") : undefined;
    return json(await listBackups(owner, scope, cursor, COLLECTION));
  }, { auth: true });

  router.add("POST", "/positions/backup", async (request) => {
    const owner = account(request);
    const body = await readJson<Record<string, unknown>>(request);
    const scope = currentScope(body.scope);
    const commitment = parseHex(body.commitment, "commitment");
    const position = executor.store.positionLifecycle.get(commitment);
    if (!position || position.ownerCommitment.toLowerCase() !== owner.toLowerCase()) {
      throw new Error("Position does not belong to the connected wallet");
    }
    const ciphertext = String(body.ciphertext ?? "");
    if (!/^pnlx-opening-backup-v1:[A-Za-z0-9_-]{80,8192}$/.test(ciphertext)) {
      throw new Error("Invalid encrypted position backup");
    }
    const id = `${owner}:${scope}:${commitment}`;
    const stored = await withCollection(async (_collection, db) => {
      const openings = db.collection<EncryptedNoteBackup>(OPENING_COLLECTION);
      await openings.updateOne(
        { _id: id },
        { $setOnInsert: { _id: id, owner, scope, commitment, ciphertext, createdAt: Date.now() } },
        { upsert: true },
      );
      return openings.findOne({ _id: id }, { projection: { ciphertext: 1 } });
    });
    if (!stored) throw new Error("Encrypted position backup could not be verified");
    return json({ ciphertext: stored.ciphertext }, 201);
  }, { auth: true });

  router.add("GET", "/positions/backups", async (request) => {
    const owner = account(request);
    const url = new URL(request.url);
    const scope = currentScope(url.searchParams.get("scope"));
    const cursor = url.searchParams.has("cursor") ? parseHex(url.searchParams.get("cursor"), "cursor") : undefined;
    return json(await listBackups(owner, scope, cursor, OPENING_COLLECTION));
  }, { auth: true });

  router.add("POST", "/notes/recovery-status", async (request) => {
    const owner = account(request);
    const body = await readJson<Record<string, unknown>>(request);
    if (!Array.isArray(body.notes) || body.notes.length > 16) throw new Error("Invalid note list");
    if (env.stellarOnchainRelay && (!relayer || !poolId)) {
      throw new Error("Shielded pool note status is unavailable");
    }
    const requests = body.notes.map((item) => {
      if (!item || typeof item !== "object") throw new Error("Invalid note");
      const note = item as Record<string, unknown>;
      const commitment = parseHex(note.commitment, "commitment");
      const nullifier = parseHex(note.nullifier, "nullifier");
      return { commitment, nullifier };
    });
    const candidates = requests.filter(({ commitment, nullifier }) =>
      executor.store.marginCommitments.has(commitment) && !executor.store.spentNullifiers.has(nullifier));
    if (env.stellarOnchainRelay && candidates.length) {
      rateLimit(`note-status:${owner}`, candidates.length, 256);
      rateLimit("note-status:global", candidates.length, 1_024);
    }
    const notes = await Promise.all(requests.map(async ({ commitment, nullifier }) => {
      const storedKnown = executor.store.marginCommitments.has(commitment);
      const storedSpent = executor.store.spentNullifiers.has(nullifier);
      let onchain: [boolean, boolean] | undefined;
      if (storedKnown && !storedSpent && env.stellarOnchainRelay && relayer && poolId) {
        onchain = await withPoolReadSlot(async () => {
          const known = await readPoolBoolean(relayer, poolId, "has_commitment", "--commitment", commitment);
          const spent = known && await readPoolBoolean(relayer, poolId, "is_spent", "--nullifier", nullifier);
          return [known, spent];
        });
      }
      return {
        commitment,
        known: storedKnown && (onchain?.[0] ?? true),
        spent: storedSpent || (onchain?.[1] ?? false),
        activeIntentCommitment: [...executor.store.intents.values()].find((intent) =>
          intent.noteNullifier.toLowerCase() === nullifier &&
          intent.ownerCommitment.toLowerCase() === owner.toLowerCase() &&
          ["open", "partially-filled"].includes(
            executor.store.orderLifecycle.get(intent.intentCommitment)?.status ?? "",
          )
        )?.intentCommitment,
      };
    }));
    return json({ notes });
  }, { auth: true });
}

async function readPoolBoolean(
  relayer: RelayerService, poolId: string, functionName: string, arg: string, value: Hex,
): Promise<boolean> {
  const result = await relayer.readAsync({
    kind: "contract-invoke",
    payload: { args: [arg, value.slice(2)], contractId: poolId, functionName, send: "no" },
  });
  const output = result.output.trim();
  if (output === "true" || output === '"true"') return true;
  if (output === "false" || output === '"false"') return false;
  throw new Error("Shielded pool note status is unavailable");
}

function collectionFor(client: MongoClient, database: string) {
  return client.db(database).collection<EncryptedNoteBackup>(COLLECTION);
}

function parseScope(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\x00-\x1f]/.test(value)) {
    throw new Error("Invalid runtime scope");
  }
  return value;
}

function parseHex(value: unknown, name: string): Hex {
  if (typeof value !== "string" || !HEX.test(value)) throw new Error(`Invalid ${name}`);
  return value.toLowerCase() as Hex;
}
