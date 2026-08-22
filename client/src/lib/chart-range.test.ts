import { describe, expect, test } from "bun:test";
import type { Logical } from "lightweight-charts";
import { latestLogicalRange } from "@/lib/chart-range";

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
});
