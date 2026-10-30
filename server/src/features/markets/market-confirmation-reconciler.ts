import type { BatchSettlement, Hex } from "@pnlx/protocol-types";
import { withPositionMutation } from "@/shared/protocol/position-mutation";
import type { ProtocolStore } from "@/shared/state/store";

interface ConfirmationReader {
  isBatchSettledAsync?(batchId: string, marketId: string, digest?: Hex): Promise<boolean>;
}

export interface ConfirmationRefresh {
  checked: number;
  confirmed: number;
  errors: number;
}

interface Candidate {
  id: string;
  batchId: string;
  marketId: string;
  settlementDigest: Hex;
  records: Array<{ key: string; identity: string }>;
}

interface SharedState {
  inFlight?: Promise<ConfirmationRefresh>;
  reads: Map<string, Promise<boolean>>;
  retries: Map<string, { failures: number; nextAt: number }>;
  nextScanAt: number;
  cursor: number;
}

const SHARED = new WeakMap<ProtocolStore, SharedState>();

/** Repairs confirmation metadata only; never submits or replays a financial transition. */
export class MarketConfirmationReconciler {
  private readonly state: SharedState;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly scanIntervalMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;

  constructor(
    private readonly store: ProtocolStore,
    private readonly reader?: ConfirmationReader,
    options: { now?: () => number; timeoutMs?: number; scanIntervalMs?: number; retryMs?: number; maxRetryMs?: number } = {},
  ) {
    this.state = SHARED.get(store) ?? { reads: new Map(), retries: new Map(), nextScanAt: 0, cursor: 0 };
    SHARED.set(store, this.state);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.scanIntervalMs = options.scanIntervalMs ?? 5_000;
    this.retryMs = options.retryMs ?? 15_000;
    this.maxRetryMs = options.maxRetryMs ?? 5 * 60_000;
  }

  refresh(): Promise<ConfirmationRefresh> {
    if (this.state.inFlight) return this.state.inFlight;
    if (!this.reader?.isBatchSettledAsync || this.now() < this.state.nextScanAt) {
      return Promise.resolve({ checked: 0, confirmed: 0, errors: 0 });
    }
    this.state.nextScanAt = this.now() + this.scanIntervalMs;
    const work = this.scan().finally(() => { if (this.state.inFlight === work) this.state.inFlight = undefined; });
    this.state.inFlight = work;
    return work;
  }

  private async scan(): Promise<ConfirmationRefresh> {
    const result = { checked: 0, confirmed: 0, errors: 0 };
    const candidates = this.candidates();
    const selected: Candidate[] = [];
    const available = Math.max(0, 2 - this.state.reads.size);
    const start = this.state.cursor;
    for (let offset = 0; offset < candidates.length && selected.length < available; offset++) {
      const index = (start + offset) % candidates.length;
      const candidate = candidates[index]!;
      if (this.state.reads.has(candidate.id) || (this.state.retries.get(candidate.id)?.nextAt ?? 0) > this.now()) continue;
      selected.push(candidate);
      this.state.cursor = (index + 1) % candidates.length;
    }
    await Promise.all(selected.map(async (candidate) => {
      result.checked++;
      const read = Promise.resolve().then(() => this.reader!.isBatchSettledAsync!(candidate.batchId, candidate.marketId, candidate.settlementDigest));
      this.state.reads.set(candidate.id, read);
      void read.finally(() => {
        if (this.state.reads.get(candidate.id) === read) this.state.reads.delete(candidate.id);
      }).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const verified = await Promise.race([
          read,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("confirmation read deadline exceeded")), this.timeoutMs);
          }),
        ]);
        if (verified !== true) { this.defer(candidate.id); return; }
        await withPositionMutation(this.store, async () => {
          let changed = 0;
          for (const captured of candidate.records) {
            const current = this.store.settlements.get(captured.key);
            if (!current || current.onchainConfirmed === true || confirmationIdentity(current) !== captured.identity) continue;
            this.store.confirmSettlementOnchain(captured.key, candidate);
            changed++;
          }
          if (changed && "flush" in this.store && typeof this.store.flush === "function") await this.store.flush();
          result.confirmed += changed;
        });
        this.state.retries.delete(candidate.id);
      } catch {
        result.errors++;
        this.defer(candidate.id);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }));
    return result;
  }

  private defer(id: string): void {
    const failures = (this.state.retries.get(id)?.failures ?? 0) + 1;
    this.state.retries.set(id, { failures, nextAt: this.now() + Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(failures - 1, 10)) });
  }

  private candidates(): Candidate[] {
    const grouped = new Map<string, Candidate>();
    for (const [key, settlement] of this.store.settlements) {
      if (settlement.onchainConfirmed === true || typeof settlement.batchId !== "string" || !settlement.batchId ||
          typeof settlement.marketId !== "string" || !settlement.marketId ||
          !/^0x[0-9a-f]{64}$/i.test(settlement.settlementDigest) || BigInt(settlement.settlementDigest) === 0n) continue;
      const id = JSON.stringify([settlement.batchId, settlement.marketId, settlement.settlementDigest]);
      const candidate = grouped.get(id) ?? { id, batchId: settlement.batchId, marketId: settlement.marketId,
        settlementDigest: settlement.settlementDigest, records: [] };
      candidate.records.push({ key, identity: confirmationIdentity(settlement) });
      grouped.set(id, candidate);
    }
    return [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

function confirmationIdentity(settlement: BatchSettlement): string {
  const { onchainConfirmed: _confirmation, proofVerificationTxHash: _proofTx, settlementTxHash: _settlementTx, ...identity } = settlement;
  return JSON.stringify(identity, (_key, value) => typeof value === "bigint" ? { bigint: value.toString() }
    : value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
}
