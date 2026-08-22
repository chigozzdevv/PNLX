import type { Logical, LogicalRange } from "lightweight-charts";

export const DEFAULT_VISIBLE_CANDLES = 96;
export const RIGHT_OFFSET_BARS = 8;

export function latestLogicalRange(candleCount: number): LogicalRange | undefined {
  if (!Number.isFinite(candleCount) || candleCount <= 0) return undefined;
  const normalizedCount = Math.floor(candleCount);
  return {
    from: (normalizedCount - DEFAULT_VISIBLE_CANDLES) as Logical,
    to: (normalizedCount - 1 + RIGHT_OFFSET_BARS) as Logical,
  };
}
