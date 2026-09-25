import { MongoClient } from "mongodb";
import type { StoredMakerNoteRecord } from "@/shared/maker-note-store";

export interface VaultMakerAllocation {
  id: string;
  allocationLedger: number;
  allocationTxHash: string;
  amount: string;
  asset: string;
  maker: string;
  noteCommitments: string[];
  remainingPrincipal?: string;
  registeredAmount: string;
  series: number;
  status: "outstanding" | "draining" | "closed";
  vault: string;
}

interface AllocationDocument extends VaultMakerAllocation {
  _id: string;
  namespace: string;
}

export function allocationId(vault: string, txHash: string): string {
  if (!/^C[A-Z2-7]{55}$/.test(vault)) throw new Error("invalid vault contract address");
  const hash = normalizedHash(txHash);
  return `${vault}:${hash}`;
}

export function remainingVaultMakerPrincipal(allocation: Pick<VaultMakerAllocation, "amount" | "remainingPrincipal">): bigint {
  const remaining = BigInt(allocation.remainingPrincipal ?? allocation.amount);
  if (remaining < 0n || remaining > BigInt(allocation.amount)) {
    throw new Error("vault maker allocation has invalid remaining principal");
  }
  return remaining;
}

export function recordedSeriesPrincipal(
  allocations: VaultMakerAllocation[], vault: string, series: number,
): bigint {
  return allocations
    .filter((allocation) => allocation.vault === vault && allocation.series === series &&
      allocation.status !== "closed")
    .reduce((sum, allocation) => sum + remainingVaultMakerPrincipal(allocation), 0n);
}

export function normalizedHash(value: string): string {
  const hash = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("invalid transaction hash");
  return hash;
}

export async function readVaultMakerAllocations(): Promise<VaultMakerAllocation[]> {
  const config = mongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const documents = await client.db(config.database)
      .collection<AllocationDocument>("vault_maker_allocations")
      .find({ namespace: config.namespace }).toArray();
    return documents.map(({ _id, namespace, ...allocation }) => allocation);
  } finally {
    await client.close();
  }
}

export async function recordVaultMakerAllocation(input: {
  allocationLedger: number;
  allocationTxHash: string;
  amount: string;
  asset: string;
  maker: string;
  series: number;
  vault: string;
}): Promise<VaultMakerAllocation> {
  const config = mongoConfig();
  const id = allocationId(input.vault, input.allocationTxHash);
  const amount = positiveAmount(input.amount).toString();
  if (!Number.isSafeInteger(input.allocationLedger) || input.allocationLedger <= 0) {
    throw new Error("allocation ledger must be confirmed");
  }
  if (!Number.isSafeInteger(input.series) || input.series < 0 || input.series > 0xffffffff) {
    throw new Error("invalid vault series");
  }
  const allocation: VaultMakerAllocation = {
    id,
    allocationLedger: input.allocationLedger,
    allocationTxHash: normalizedHash(input.allocationTxHash),
    amount,
    asset: input.asset,
    maker: input.maker,
    noteCommitments: [],
    remainingPrincipal: amount.toString(),
    registeredAmount: "0",
    series: input.series,
    status: "outstanding",
    vault: input.vault,
  };
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    await client.db(config.database).collection<AllocationDocument>("vault_maker_allocations")
      .insertOne({ ...allocation, _id: `${config.namespace}:${id}`, namespace: config.namespace });
    return allocation;
  } finally {
    await client.close();
  }
}

export async function closeVaultMakerAllocation(id: string): Promise<void> {
  const config = mongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const database = client.db(config.database);
    const activeNotes = await database.collection<StoredMakerNoteRecord & { namespace: string }>("maker_notes")
      .countDocuments({ namespace: config.namespace, vaultAllocationId: id,
        status: { $in: ["pending", "available", "locked", "draining", "withdrawing"] } });
    if (activeNotes !== 0) throw new Error(`${activeNotes} maker notes still belong to the vault allocation`);
    const result = await database.collection<AllocationDocument>("vault_maker_allocations").updateOne(
      { _id: `${config.namespace}:${id}`, status: { $in: ["outstanding", "draining"] } },
      { $set: { status: "closed", remainingPrincipal: "0" } },
    );
    if (result.matchedCount !== 1) throw new Error("outstanding vault allocation was not found");
  } finally {
    await client.close();
  }
}

export async function beginVaultMakerDrain(id: string): Promise<void> {
  const config = mongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const database = client.db(config.database);
    const allocations = database.collection<AllocationDocument>("vault_maker_allocations");
    const allocation = await allocations.findOne({ _id: `${config.namespace}:${id}`, namespace: config.namespace });
    if (!allocation || (allocation.status !== "outstanding" && allocation.status !== "draining")) {
      throw new Error("outstanding vault allocation was not found for draining");
    }
    await allocations.updateOne(
      { _id: `${config.namespace}:${id}`, namespace: config.namespace, status: "outstanding" },
      { $set: { status: "draining" } },
    );
    await database.collection<StoredMakerNoteRecord & { namespace: string }>("maker_notes").updateMany(
      { namespace: config.namespace, vaultAllocationId: id, status: "available" },
      { $set: { status: "draining", updatedAt: Date.now() } },
    );
  } finally {
    await client.close();
  }
}

// The allocation is reserved before the note is tagged. A failure between those
// writes leaves capacity reserved and the note ineligible, never the reverse.
export async function registerVaultMakerNote(input: {
  allocationTxHash: string;
  asset: string;
  commitment: string;
  depositTxHash: string;
  maker: string;
  noteAmount: string;
  vault: string;
}): Promise<VaultMakerAllocation> {
  const config = mongoConfig();
  const id = allocationId(input.vault, input.allocationTxHash);
  const noteAmount = positiveAmount(input.noteAmount);
  const depositTxHash = normalizedHash(input.depositTxHash);
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const database = client.db(config.database);
    const allocations = database.collection<AllocationDocument>("vault_maker_allocations");
    const notes = database.collection<StoredMakerNoteRecord & { _id: string; namespace: string }>("maker_notes");
    const noteId = `${config.namespace}:${input.commitment}`;
    const note = await notes.findOne({ _id: noteId, namespace: config.namespace });
    if (!note || note.status !== "available" || note.walletAddress !== input.maker ||
      note.token !== input.asset || note.amount !== noteAmount.toString() ||
      note.vaultParentCommitment ||
      normalizedHash(String(note.depositTxHash ?? "")) !== depositTxHash) {
      throw new Error("maker note does not match the verified vault deposit");
    }
    if (note.vaultAllocationId && note.vaultAllocationId !== id) {
      throw new Error("maker note already belongs to another allocation");
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await allocations.findOne({ _id: `${config.namespace}:${id}` });
      if (!current || current.vault !== input.vault || current.asset !== input.asset ||
        current.maker !== input.maker ||
        !Number.isSafeInteger(current.series) || current.series < 0 ||
        current.status !== "outstanding") {
        throw new Error("recorded vault allocation was not found for registration");
      }
      if (current.noteCommitments.includes(input.commitment)) break;
      const nextAmount = BigInt(current.registeredAmount) + noteAmount;
      if (nextAmount > BigInt(current.amount)) throw new Error("maker notes exceed vault allocation");
      const updated = await allocations.updateOne(
        { _id: current._id, registeredAmount: current.registeredAmount,
          noteCommitments: { $ne: input.commitment }, status: "outstanding" },
        { $set: { registeredAmount: nextAmount.toString() },
          $addToSet: { noteCommitments: input.commitment } },
      );
      if (updated.modifiedCount === 1) break;
      if (attempt === 4) throw new Error("vault allocation changed during registration");
    }

    const tagged = await notes.updateOne(
      { _id: noteId, namespace: config.namespace, status: "available",
        walletAddress: input.maker, token: input.asset, amount: noteAmount.toString(),
        depositTxHash: note.depositTxHash,
        vaultParentCommitment: { $exists: false },
        $or: [{ vaultAllocationId: { $exists: false } }, { vaultAllocationId: id }] },
      { $set: { vaultAllocationId: id, updatedAt: Date.now() } },
    );
    if (tagged.matchedCount !== 1) {
      throw new Error("maker note changed before vault backing could be attached");
    }
    const registered = await allocations.findOne({ _id: `${config.namespace}:${id}` });
    if (!registered) throw new Error("vault allocation registration disappeared");
    const { _id, namespace, ...result } = registered;
    return result;
  } finally {
    await client.close();
  }
}

export function eligibleVaultMakerNotes<T extends StoredMakerNoteRecord & {
  commitment: string;
  status: string;
  walletAddress: string;
}>(
  notes: T[],
  allocations: VaultMakerAllocation[],
  input: { asset: string; deployedPrincipal: bigint; maker: string; seriesPrincipals: Map<number, bigint>; vault: string },
): T[] {
  const candidates = allocations
    .filter((allocation) => allocation.status === "outstanding" && allocation.vault === input.vault &&
      allocation.maker === input.maker && allocation.asset === input.asset &&
      Number.isSafeInteger(allocation.series) && allocation.series >= 0 &&
      (input.seriesPrincipals.get(allocation.series) ?? 0n) >= remainingVaultMakerPrincipal(allocation) &&
      remainingVaultMakerPrincipal(allocation) > 0n && BigInt(allocation.registeredAmount) <= BigInt(allocation.amount));
  const bySeries = new Map<number, bigint>();
  for (const allocation of candidates) {
    bySeries.set(allocation.series, (bySeries.get(allocation.series) ?? 0n) + remainingVaultMakerPrincipal(allocation));
  }
  const active = new Map(candidates
    .filter((allocation) => bySeries.get(allocation.series)! <= input.seriesPrincipals.get(allocation.series)!)
    .map((allocation) => [allocation.id, allocation]));
  const totalOutstanding = [...active.values()].reduce((sum, allocation) => sum + remainingVaultMakerPrincipal(allocation), 0n);
  if (totalOutstanding === 0n || totalOutstanding > input.deployedPrincipal) return [];

  const byCommitment = new Map(notes.map((note) => [note.commitment, note]));
  const eligible = notes.filter((note) => {
    if (note.status !== "available" || note.walletAddress !== input.maker || note.token !== input.asset) return false;
    const id = String(note.vaultAllocationId ?? "");
    const allocation = active.get(id);
    if (!allocation) return false;
    const visited = new Set<string>();
    let candidate: T | undefined = note;
    while (candidate?.vaultParentCommitment) {
      if (visited.has(candidate.commitment) || candidate.vaultAllocationId !== id) return false;
      visited.add(candidate.commitment);
      const parent = byCommitment.get(String(candidate.vaultParentCommitment));
      if (!parent || parent.status !== "spent" || parent.walletAddress !== input.maker ||
        parent.token !== input.asset || BigInt(String(parent.amount)) < BigInt(String(candidate.amount))) return false;
      candidate = parent;
    }
    return Boolean(candidate && candidate.vaultAllocationId === id &&
      allocation.noteCommitments.includes(candidate.commitment));
  });
  const availableByAllocation = new Map<string, bigint>();
  for (const note of eligible) {
    const id = String(note.vaultAllocationId);
    availableByAllocation.set(id, (availableByAllocation.get(id) ?? 0n) + BigInt(String(note.amount)));
  }
  const overloaded = new Set([...availableByAllocation]
    .filter(([id, amount]) => amount > remainingVaultMakerPrincipal(active.get(id)!))
    .map(([id]) => id));
  return eligible.filter((note) => !overloaded.has(String(note.vaultAllocationId)));
}

function positiveAmount(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("amount must be positive base units");
  return BigInt(value);
}

function mongoConfig(): { uri: string; database: string; namespace: string } {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required for vault maker backing");
  return {
    uri: process.env.MONGODB_URI,
    database: process.env.MONGODB_DATABASE || "pnlx",
    namespace: process.env.STELLAR_NETWORK || "testnet",
  };
}
