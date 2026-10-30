import type { ProtocolStore } from "@/shared/state/store";

export interface MarketRiskFundingSnapshot {
  status: "available" | "unavailable";
  source: "onchain-market" | "market-config";
  fundingIndex: bigint | null;
  updatedAt: number | null;
}

interface FundingReader {
  marketFundingIndexAsync?(marketId: string): Promise<bigint>;
}

interface FundingEntry {
  value?: bigint;
  updatedAt?: number;
  failed: boolean;
  nextAt: number;
  job?: FundingJob;
}

interface FundingJob {
  marketId: string;
  owner: MarketRiskFunding;
  entry: FundingEntry;
  done: Promise<void>;
  resolve(): void;
}

interface SharedState {
  entries: Map<string, FundingEntry>;
  queue: FundingJob[];
  active: number;
}

const SHARED = new WeakMap<ProtocolStore, SharedState>();
const XLM_MARKET = "xlm-usd-perp";

/** Read-only risk snapshots; stalled RPCs keep their actual read lease after the display deadline. */
export class MarketRiskFunding {
  private readonly state: SharedState;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly refreshMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly store: ProtocolStore,
    private readonly reader?: FundingReader,
    options: { now?: () => number; maxAgeMs?: number; refreshMs?: number; retryMs?: number; timeoutMs?: number } = {},
  ) {
    this.state = SHARED.get(store) ?? { entries: new Map(), queue: [], active: 0 };
    SHARED.set(store, this.state);
    this.now = options.now ?? Date.now;
    this.maxAgeMs = duration(options.maxAgeMs, 60_000);
    this.refreshMs = duration(options.refreshMs, 15_000);
    this.retryMs = duration(options.retryMs, 30_000);
    this.timeoutMs = duration(options.timeoutMs, 8_000);
  }

  snapshot(marketId: string, configFundingIndex: bigint, requireOnchain: boolean): MarketRiskFundingSnapshot {
    if (!requireOnchain) {
      const available = typeof configFundingIndex === "bigint";
      return { status: available ? "available" : "unavailable", source: "market-config",
        fundingIndex: available ? configFundingIndex : null, updatedAt: available ? this.now() : null };
    }
    const entry = this.state.entries.get(marketId);
    const age = entry?.updatedAt === undefined ? Infinity : this.now() - entry.updatedAt;
    const available = typeof this.reader?.marketFundingIndexAsync === "function" && entry?.value !== undefined &&
      !entry.failed && age >= 0 && age <= this.maxAgeMs;
    return {
      status: available ? "available" : "unavailable", source: "onchain-market",
      fundingIndex: available ? entry!.value! : null, updatedAt: entry?.updatedAt ?? null,
    };
  }

  refresh(marketIds: readonly string[]): Promise<void> {
    if (typeof this.reader?.marketFundingIndexAsync !== "function") return Promise.resolve();
    const requested = [...new Set(marketIds)].filter((id) => this.store.markets.has(id));
    requested.sort((left, right) => Number(right === XLM_MARKET) - Number(left === XLM_MARKET));
    const waiting: Promise<void>[] = [];
    for (const marketId of requested) {
      const entry = this.state.entries.get(marketId) ?? { failed: false, nextAt: 0 };
      this.state.entries.set(marketId, entry);
      if (entry.job) { waiting.push(entry.job.done); continue; }
      if (this.now() < entry.nextAt) continue;
      let resolve!: () => void;
      const done = new Promise<void>((complete) => { resolve = complete; });
      const job = { marketId, owner: this, entry, done, resolve };
      entry.job = job;
      if (marketId === XLM_MARKET) this.state.queue.unshift(job);
      else this.state.queue.push(job);
      waiting.push(done);
    }
    this.drain();
    return Promise.all(waiting).then(() => undefined);
  }

  private drain(): void {
    while (this.state.active < 2 && this.state.queue.length) {
      const job = this.state.queue.shift()!;
      this.state.active++;
      job.owner.read(job);
    }
  }

  private read(job: FundingJob): void {
    let finished = false;
    const finish = (value?: bigint) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const success = typeof value === "bigint";
      job.entry.failed = !success;
      job.entry.nextAt = this.now() + (success ? this.refreshMs : this.retryMs);
      if (success) {
        job.entry.value = value;
        job.entry.updatedAt = this.now();
      }
      job.resolve();
    };
    const timer = setTimeout(() => finish(), this.timeoutMs);
    timer.unref?.();
    const read = Promise.resolve().then(() => this.reader!.marketFundingIndexAsync!(job.marketId));
    void read.then((value) => finish(value), () => finish()).finally(() => {
      // A timeout resolves the wrapper, but only actual RPC completion frees capacity.
      if (job.entry.job === job) job.entry.job = undefined;
      this.state.active--;
      this.drain();
    });
  }
}

function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2_147_483_647) throw new Error("invalid risk funding cache interval");
  return result;
}
