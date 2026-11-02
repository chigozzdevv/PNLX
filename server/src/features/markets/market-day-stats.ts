import { SUPPORTED_PERP_ASSETS } from "@/config/assets";
import type { MarketDayStats } from "@/features/markets/markets.model";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CANDLES_PER_DAY = 1_440;
type StatsFetcher = (url: string, init: RequestInit) => Promise<Response>;

/** One reference-trade window for change and extrema, independent of chart interval. */
export class MarketDayStatsService {
  private readonly snapshots = new Map<string, MarketDayStats>();
  private readonly inflight = new Map<string, Promise<MarketDayStats>>();

  constructor(
    private readonly fetcher: StatsFetcher = (url, init) => globalThis.fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {}

  stats(marketId: string): Promise<MarketDayStats> {
    const asset = Object.values(SUPPORTED_PERP_ASSETS).find((candidate) => candidate.marketId === marketId);
    if (!asset) return Promise.reject(new Error(`unsupported reference-statistics market ${marketId}`));
    const asOf = Math.floor(this.now() / MINUTE_MS) * MINUTE_MS;
    const cached = this.snapshots.get(marketId);
    if (cached?.asOf === asOf) return Promise.resolve({ ...cached, stale: false });
    const key = `${marketId}:${asOf}`;
    const current = this.inflight.get(key);
    if (current) return current;
    const request = this.load(marketId, asset.symbol, asOf).catch((error: unknown) => {
      const previous = this.snapshots.get(marketId);
      if (previous) return { ...previous, stale: this.now() - previous.asOf > 2 * MINUTE_MS };
      throw error;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private async load(marketId: string, symbol: string, asOf: number): Promise<MarketDayStats> {
    const from = asOf - DAY_MS;
    const response = await this.fetcher("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "pnlx-market-stats/0.1" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: symbol, interval: "1m", startTime: from, endTime: asOf - 1 } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`reference statistics provider failed with ${response.status}`);
    const stats = parseMarketDayStats(await response.json(), marketId, symbol, from, asOf, this.now());
    const latest = this.snapshots.get(marketId);
    if (latest && latest.asOf > stats.asOf) return { ...latest, stale: this.now() - latest.asOf > 2 * MINUTE_MS };
    if (stats.asOf >= (this.snapshots.get(marketId)?.asOf ?? 0)) this.snapshots.set(marketId, stats);
    return { ...stats, stale: this.now() - stats.asOf > 2 * MINUTE_MS };
  }
}

export function parseMarketDayStats(
  payload: unknown,
  marketId: string,
  symbol: string,
  from: number,
  asOf: number,
  fetchedAt: number,
): MarketDayStats {
  if (!Array.isArray(payload)) throw new Error("invalid reference statistics candle response");
  if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(asOf) ||
    from % MINUTE_MS !== 0 || asOf - from !== DAY_MS || !Number.isSafeInteger(fetchedAt) || fetchedAt < asOf) {
    throw new Error("invalid reference statistics time window");
  }
  let count = 0;
  let high24h = Number.NEGATIVE_INFINITY;
  let low24h = Number.POSITIVE_INFINITY;
  let open24h = 0;
  let lastPrice = 0;
  for (const item of payload) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid reference statistics candle");
    const row = item as Record<string, unknown>;
    const time = finiteDecimal(row.t);
    if (!Number.isSafeInteger(time)) throw new Error("invalid reference statistics candle time");
    // Provider boundary neighbours, including the unfinished minute, are not part of this window.
    if (time < from || time >= asOf) continue;
    if (row.s !== symbol || row.i !== "1m") throw new Error("reference statistics candle source mismatch");
    if (time !== from + count * MINUTE_MS) throw new Error("incomplete or unordered 24h reference candle coverage");
    if (row.T !== undefined && finiteDecimal(row.T) !== time + MINUTE_MS - 1) {
      throw new Error("invalid reference statistics candle close time");
    }
    const open = finiteDecimal(row.o), high = finiteDecimal(row.h), low = finiteDecimal(row.l), close = finiteDecimal(row.c);
    if ([open, high, low, close].some((price) => price <= 0) ||
      high < Math.max(open, close) || low > Math.min(open, close)) throw new Error("invalid reference statistics OHLC");
    if (count === 0) open24h = open;
    high24h = Math.max(high24h, high);
    low24h = Math.min(low24h, low);
    lastPrice = close;
    count++;
  }
  if (count !== CANDLES_PER_DAY) throw new Error("incomplete 24h reference candle coverage");
  const change24h = ((lastPrice - open24h) / open24h) * 100;
  if (!Number.isFinite(change24h)) throw new Error("invalid reference statistics price change");
  return { marketId, source: "hyperliquid", interval: "1m", from, asOf, fetchedAt,
    change24h, high24h, low24h, open24h, lastPrice, stale: false };
}

function finiteDecimal(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) throw new Error("invalid reference statistics numeric value");
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("invalid reference statistics numeric value");
  return number;
}
