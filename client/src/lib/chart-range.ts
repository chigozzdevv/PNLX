import type { Logical, LogicalRange } from "lightweight-charts";

export const DEFAULT_VISIBLE_CANDLES = 96;
export const RIGHT_OFFSET_BARS = 8;
export const DEFAULT_BAR_SPACING = 7;
export const MIN_BAR_SPACING = 1.5;
export const MAX_BAR_SPACING = 24;

export function latestLogicalRange(candleCount: number, width?: number): LogicalRange | undefined {
  if (!Number.isFinite(candleCount) || candleCount <= 0) return undefined;
  const normalizedCount = Math.floor(candleCount);
  const visibleCandles = width !== undefined && Number.isFinite(width) && width > 0
    ? Math.max(24, Math.floor(width / DEFAULT_BAR_SPACING) - RIGHT_OFFSET_BARS)
    : DEFAULT_VISIBLE_CANDLES;
  return {
    from: (normalizedCount - visibleCandles) as Logical,
    to: (normalizedCount - 1 + RIGHT_OFFSET_BARS) as Logical,
  };
}

interface TimedBar { time: string }

export function isFollowingLatest(range: LogicalRange | null, candleCount: number): boolean {
  return !range || range.to >= candleCount - 1;
}

/** Preserve bar width and the user's current position, including unloaded whitespace. */
export function preserveLogicalRange(
  range: LogicalRange | null,
  previous: readonly TimedBar[],
  next: readonly TimedBar[],
  followingLatest = false,
): LogicalRange | undefined {
  if (!range || previous.length === 0 || next.length === 0) return undefined;
  let shift: number;
  if (followingLatest) {
    shift = next.length - previous.length;
  } else {
    const nextIndexes = new Map(next.map((bar, index) => [bar.time, index]));
    const anchorIndex = Math.max(0, Math.min(previous.length - 1, Math.floor(range.to)));
    const nextAnchorIndex = nextIndexes.get(previous[anchorIndex].time);
    if (nextAnchorIndex !== undefined) shift = nextAnchorIndex - anchorIndex;
    else {
      const sharedIndex = previous.findIndex((bar) => nextIndexes.has(bar.time));
      if (sharedIndex < 0) return undefined;
      shift = nextIndexes.get(previous[sharedIndex].time)! - sharedIndex;
    }
  }
  return { from: (range.from + shift) as Logical, to: (range.to + shift) as Logical };
}

export function zoomLogicalRange(
  range: LogicalRange,
  factor: number,
  anchorRatio: number,
  width: number,
): LogicalRange {
  const ratio = Math.max(0, Math.min(1, anchorRatio));
  const span = range.to - range.from;
  const bars = Math.min(width / MIN_BAR_SPACING, Math.max(width / MAX_BAR_SPACING, (span + 1) * factor));
  const nextSpan = Math.max(1, bars - 1);
  const anchor = range.from + span * ratio;
  return { from: (anchor - nextSpan * ratio) as Logical, to: (anchor + nextSpan * (1 - ratio)) as Logical };
}
