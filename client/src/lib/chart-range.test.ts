import { describe, expect, test } from "bun:test";
import type { Logical, LogicalRange } from "lightweight-charts";
import { isFollowingLatest, latestLogicalRange, preserveLogicalRange, zoomLogicalRange } from "@/lib/chart-range";

function bars(from: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({ time: String(from + index) }));
}
function range(from: number, to: number): LogicalRange {
  return { from: from as Logical, to: to as Logical };
}

describe("latest chart range", () => {
  test("keeps a lone initial candle at the normal bar scale", () => {
    expect(latestLogicalRange(1)).toEqual({ from: -95 as Logical, to: 8 as Logical });
  });

  test("shows the latest 96 candles when history is available", () => {
    expect(latestLogicalRange(300)).toEqual({ from: 204 as Logical, to: 307 as Logical });
  });

  test("ignores empty or invalid candle counts", () => {
    expect(latestLogicalRange(0)).toBeUndefined();
    expect(latestLogicalRange(Number.NaN)).toBeUndefined();
  });

  test("keeps a consistent initial candle density across desktop widths", () => {
    const narrow = latestLogicalRange(300, 700)!;
    const wide = latestLogicalRange(300, 1_400)!;
    expect(700 / (narrow.to - narrow.from + 1)).toBe(7);
    expect(1_400 / (wide.to - wide.from + 1)).toBe(7);
    expect(latestLogicalRange(1, 700)).toEqual(range(-91, 8));
  });
});

describe("chart viewport preservation", () => {
  test("backfill keeps a 104-bar viewport even when only two existing candles are visible", () => {
    const previous = bars(300, 300);
    const next = bars(0, 600);
    const viewport = range(-101.5, 1.5);
    const result = preserveLogicalRange(viewport, previous, next)!;
    expect(result).toEqual(range(198.5, 301.5));
    expect(result.to - result.from).toBe(viewport.to - viewport.from);
    expect(next[Math.floor(result.to)].time).toBe(previous[Math.floor(viewport.to)].time);
  });

  test("uses the user's current position after further panning during a request", () => {
    expect(preserveLogicalRange(range(-190.25, -87.25), bars(300, 300), bars(0, 600)))
      .toEqual(range(109.75, 212.75));
  });

  test("live appends preserve historical views and move a following view by one bar", () => {
    const previous = bars(0, 300);
    const next = bars(0, 301);
    expect(preserveLogicalRange(range(50.25, 153.25), previous, next)).toEqual(range(50.25, 153.25));
    expect(preserveLogicalRange(range(204, 307), previous, next, true)).toEqual(range(205, 308));
    expect(isFollowingLatest(range(204, 307), 300)).toBe(true);
    expect(isFollowingLatest(range(195, 298), 300)).toBe(false);
  });

  test("retained-window pruning keeps the same historical candles under the viewport", () => {
    expect(preserveLogicalRange(range(50, 153), bars(0, 300), bars(1, 300))).toEqual(range(49, 152));
    expect(preserveLogicalRange(range(204, 307), bars(0, 300), bars(1, 300), true)).toEqual(range(204, 307));
  });

  test("overlapping backfill counts only genuinely inserted candles", () => {
    expect(preserveLogicalRange(range(0, 103), bars(300, 300), bars(150, 450))).toEqual(range(150, 253));
  });

  test("explicit zoom stays anchored and limits oversized candles", () => {
    const zoomed = zoomLogicalRange(range(0, 99), 0.0001, 0.25, 720);
    expect(zoomed.to - zoomed.from + 1).toBe(30);
    expect(zoomed.from + (zoomed.to - zoomed.from) * 0.25).toBe(24.75);
    expect(zoomLogicalRange(range(0, 99), 1_000, 0.5, 720).to -
      zoomLogicalRange(range(0, 99), 1_000, 0.5, 720).from + 1).toBe(480);
  });
});
