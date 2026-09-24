import { MongoClient, type Db } from "mongodb";
import type { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";

const TRANSFER_TOPIC = "AAAADwAAAAh0cmFuc2Zlcg==";
const POLL_MS = 60_000;
const SNAPSHOT_MS = 300_000;

export type VaultActivityKind = "supply" | "allocation" | "return" | "withdrawal";

export interface VaultActivity {
  id: string;
  kind: VaultActivityKind;
  amount: string;
  at: string;
  ledger: number;
  txHash: string;
}

export interface VaultAssetPoint {
  at: string;
  assets: string;
}

interface StoredActivity extends VaultActivity { _id: string; vault: string; network: string }
interface StoredPoint extends VaultAssetPoint { _id?: string; vault: string; network: string; shares: string }
interface Cursor { _id: string; ledger: number }

interface RpcEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  topic: string[];
  value: string;
  txHash: string;
  inSuccessfulContractCall?: boolean;
}

export class LiquidityVaultHistory {
  private inFlight: Promise<void> | null = null;
  private lastPoll = 0;
  private lastSnapshot = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private asset: string | null = null;
  private maker: string | null = null;

  constructor(
    private readonly vault: LiquidityVaultService,
    private readonly config: { uri: string; database: string; network: string; rpcUrl: string; vaultId: string },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.sync().catch((error) => console.error("vault history sync failed", error));
    this.timer = setInterval(() => {
      void this.sync().catch((error) => console.error("vault history sync failed", error));
    }, POLL_MS);
    this.timer.unref?.();
  }

  async history(): Promise<{ activity: VaultActivity[]; assets: VaultAssetPoint[]; stale: boolean; observedAt: string | null }> {
    const stale = await this.sync().then(() => false, () => true);
    const client = new MongoClient(this.config.uri);
    try {
      await client.connect();
      const db = client.db(this.config.database);
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const pointFilter = { vault: this.config.vaultId, network: this.config.network };
      const [activity, assets, previous] = await Promise.all([
        db.collection<StoredActivity>("vault_activity")
          .find({ vault: this.config.vaultId, network: this.config.network }).sort({ ledger: -1, id: -1 }).limit(12).toArray(),
        db.collection<StoredPoint>("vault_asset_points")
          .find({ ...pointFilter, at: { $gte: since } }).sort({ at: 1 }).toArray(),
        db.collection<StoredPoint>("vault_asset_points")
          .findOne({ ...pointFilter, at: { $lt: since } }, { sort: { at: -1 } }),
      ]);
      return {
        activity: activity.map(({ id, kind, amount, at, ledger, txHash }) => ({ id, kind, amount, at, ledger, txHash })),
        assets: (previous ? [previous, ...assets] : assets).map(({ at, assets: amount }) => ({ at, assets: amount })),
        stale,
        observedAt: this.lastSnapshot ? new Date(this.lastSnapshot).toISOString() : null,
      };
    } finally {
      await client.close();
    }
  }

  sync(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (Date.now() - this.lastPoll < POLL_MS) return Promise.resolve();
    this.inFlight = this.syncOnce().then(() => { this.lastPoll = Date.now(); })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async syncOnce(): Promise<void> {
    const status = !this.asset || Date.now() - this.lastSnapshot >= SNAPSHOT_MS
      ? await this.vault.status() : null;
    const client = new MongoClient(this.config.uri);
    try {
      await client.connect();
      const db = client.db(this.config.database);
      if (status) {
        await this.recordPoint(db, status.totalAssetsAtCost, status.totalShares);
        this.asset = status.asset;
        this.maker = status.maker;
        this.lastSnapshot = Date.now();
      }
      if (!this.asset || !this.maker) throw new Error("vault history asset is unavailable");
      await this.ingestTransfers(db, this.asset, this.maker);
    } finally {
      await client.close();
    }
  }

  private async recordPoint(db: Db, assets: string, shares: string): Promise<void> {
    const collection = db.collection<StoredPoint>("vault_asset_points");
    const previous = await collection.findOne({ vault: this.config.vaultId, network: this.config.network }, { sort: { at: -1 } });
    if (previous?.assets === assets && previous.shares === shares) return;
    await collection.insertOne({ vault: this.config.vaultId, network: this.config.network,
      assets, shares, at: new Date().toISOString() });
  }

  private async ingestTransfers(db: Db, asset: string, maker: string): Promise<void> {
    const vaultTopic = addressTopic(this.config.vaultId);
    const makerTopic = addressTopic(maker);
    const filters = [{ type: "contract", contractIds: [asset], topics: [
      [TRANSFER_TOPIC, vaultTopic, "*", "*"],
      [TRANSFER_TOPIC, "*", vaultTopic, "*"],
    ] }];
    const tip = await this.rpc<{ sequence: number }>("getLatestLedger", {});
    const cursorId = `${this.config.network}:${this.config.vaultId}`;
    const cursors = db.collection<Cursor>("vault_activity_cursors");
    const cursor = await cursors.findOne({ _id: cursorId });
    let start = cursor ? cursor.ledger + 1 : tip.sequence;
    if (start > tip.sequence) return;
    // A current-ledger query supplies the RPC node's actual retention boundary.
    const boundary = await this.rpc<{ oldestLedger: number }>("getEvents", {
      startLedger: tip.sequence, filters, pagination: { limit: 1 },
    });
    start = cursor ? Math.max(start, boundary.oldestLedger + 120) : boundary.oldestLedger + 120;
    let pageCursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.rpc<{ events: RpcEvent[]; cursor?: string }>("getEvents", {
        ...(pageCursor ? {} : { startLedger: start, endLedger: tip.sequence + 1 }),
        filters,
        pagination: { ...(pageCursor ? { cursor: pageCursor } : {}), limit: 200 },
      });
      const documents: StoredActivity[] = [];
      for (const event of result.events) {
        const activity = parseVaultTransfer(event, asset, vaultTopic, makerTopic);
        if (activity && await this.confirmVaultAction(activity)) {
          documents.push({ ...activity, _id: `${cursorId}:${event.id}`, vault: this.config.vaultId,
            network: this.config.network });
        }
      }
      if (documents.length) {
        await db.collection<StoredActivity>("vault_activity").bulkWrite(documents.map((document) => ({
          updateOne: { filter: { _id: document._id }, update: { $setOnInsert: document }, upsert: true },
        })));
      }
      if (!result.cursor) throw new Error("Stellar RPC did not return an event cursor");
      if (result.cursor === pageCursor) throw new Error("Stellar RPC event cursor did not advance");
      pageCursor = result.cursor;
      const scannedLedger = Number(BigInt(pageCursor.slice(0, 19)) >> 32n);
      if (scannedLedger >= tip.sequence) break;
      if (page === 99) throw new Error("vault activity scan exceeded the page limit");
    }
    await cursors.updateOne({ _id: cursorId }, { $set: { ledger: tip.sequence } }, { upsert: true });
  }

  private async rpc<T>(method: string, params: object): Promise<T> {
    const response = await fetch(this.config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Stellar RPC returned ${response.status}`);
    const body = await response.json() as { result?: T; error?: { message?: string } };
    if (!body.result) throw new Error(body.error?.message ?? "Stellar RPC did not return a result");
    return body.result;
  }

  private async confirmVaultAction(activity: VaultActivity): Promise<boolean> {
    const tx = await this.rpc<{ status: string; ledger: number; envelopeJson?: unknown }>("getTransaction", {
      hash: activity.txHash, xdrFormat: "json",
    });
    if (tx.status !== "SUCCESS" || tx.ledger !== activity.ledger) return false;
    const envelope = tx.envelopeJson as { tx?: { tx?: { operations?: Array<{
      body?: { invoke_host_function?: { host_function?: { invoke_contract?: {
        contract_address?: string; function_name?: string;
      } } } }
    }> } } } | undefined;
    const methods: Record<VaultActivityKind, string[]> = {
      supply: ["deposit"], allocation: ["allocate"], return: ["settle"],
      withdrawal: ["withdraw", "claim_withdrawal"],
    };
    return envelope?.tx?.tx?.operations?.some((operation) => {
      const invocation = operation.body?.invoke_host_function?.host_function?.invoke_contract;
      return invocation?.contract_address === this.config.vaultId &&
        methods[activity.kind].includes(invocation.function_name ?? "");
    }) ?? false;
  }
}

export function readI128(encoded: string): bigint {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 20 || bytes.readInt32BE(0) !== 10) return 0n;
  return (bytes.readBigInt64BE(4) << 64n) + bytes.readBigUInt64BE(12);
}

export function parseVaultTransfer(event: RpcEvent, asset: string, vaultTopic: string, makerTopic: string): VaultActivity | null {
  if (event.type !== "contract" || event.contractId !== asset || event.inSuccessfulContractCall === false ||
    !/^[a-f0-9]{64}$/i.test(event.txHash) || event.topic[0] !== TRANSFER_TOPIC) return null;
  const from = event.topic[1];
  const to = event.topic[2];
  let kind: VaultActivityKind;
  if (from === vaultTopic) kind = to === makerTopic ? "allocation" : "withdrawal";
  else if (to === vaultTopic) kind = from === makerTopic ? "return" : "supply";
  else return null;
  const amount = readI128(event.value);
  if (amount <= 0n || !Number.isSafeInteger(event.ledger) || !Number.isFinite(Date.parse(event.ledgerClosedAt))) return null;
  return { id: event.id, kind, amount: amount.toString(), at: event.ledgerClosedAt,
    ledger: event.ledger, txHash: event.txHash.toLowerCase() };
}

export function addressTopic(address: string): string {
  const raw = decodeStrKey(address);
  const bytes = Buffer.alloc(address.startsWith("G") ? 44 : 40);
  bytes.writeInt32BE(18, 0); // ScVal::Address
  bytes.writeInt32BE(address.startsWith("C") ? 1 : 0, 4); // contract or account
  if (address.startsWith("G")) bytes.writeInt32BE(0, 8); // PublicKeyType::Ed25519
  raw.copy(bytes, address.startsWith("G") ? 12 : 8, 1, 33);
  return bytes.subarray(0, address.startsWith("G") ? 44 : 40).toString("base64");
}

function decodeStrKey(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  const output: number[] = [];
  for (const letter of value) {
    const digit = alphabet.indexOf(letter);
    if (digit < 0) throw new Error("invalid Stellar address");
    acc = (acc << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((acc >> bits) & 255);
    }
  }
  const bytes = Buffer.from(output);
  if (bytes.length !== 35 || bytes[0] !== (value.startsWith("C") ? 16 : 48)) {
    throw new Error("invalid Stellar address");
  }
  return bytes;
}
