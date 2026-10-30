import type { MarketDayStats } from "@/types/trading";

export function parseMarketDayStats(payload: unknown, marketId: string, now = Date.now()): MarketDayStats {
  if (!payload || typeof payload !== "object") throw new Error("Missing reference market statistics");
  const stats = payload as MarketDayStats;
  const numbers = [stats.from, stats.asOf, stats.fetchedAt, stats.change24h,
    stats.high24h, stats.low24h, stats.open24h, stats.lastPrice];
  if (stats.marketId !== marketId || stats.source !== "hyperliquid" || stats.interval !== "1m" ||
    typeof stats.stale !== "boolean" || numbers.some((value) => !Number.isFinite(value)) ||
    stats.asOf - stats.from !== 86_400_000 || stats.from % 60_000 !== 0 || stats.asOf % 60_000 !== 0 ||
    stats.fetchedAt < stats.asOf || stats.fetchedAt > now + 60_000 ||
    stats.low24h <= 0 || stats.open24h < stats.low24h || stats.open24h > stats.high24h ||
    stats.lastPrice < stats.low24h || stats.lastPrice > stats.high24h ||
    Math.abs(stats.change24h - (stats.lastPrice / stats.open24h - 1) * 100) > 0.000001) {
    throw new Error("Invalid reference market statistics");
  }
  return { ...stats, stale: stats.stale || now - stats.asOf > 120_000 };
}
