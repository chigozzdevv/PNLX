import { describe, expect, test } from "bun:test";
import { chartVolumeData } from "@/lib/chart-volume";
import type { ChartCandle } from "@/types/trading";

const candle = (overrides: Partial<ChartCandle> = {}): ChartCandle => ({
  close: 11,
  high: 12,
  low: 9,
  open: 10,
  time: "2026-08-13T12:00:00.000Z",
  volume: 20,
  ...overrides,
});

describe("chart volume data", () => {
  test("returns no histogram data when the interval has no reported volume", () => {
    expect(chartVolumeData([
      candle({ volume: 0 }),
      candle({ time: "2026-08-13T12:01:00.000Z", volume: 0 }),
    ])).toEqual([]);
  });

  test("colors volume by candle direction and clamps invalid values", () => {
    const result = chartVolumeData([
      candle({ volume: 12 }),
      candle({ close: 9, open: 10, time: "2026-08-13T12:01:00.000Z", volume: 7 }),
      candle({ time: "2026-08-13T12:02:00.000Z", volume: -4 }),
    ]);

    expect(result.map(({ value }) => value)).toEqual([12, 7, 0]);
    expect(result[0]?.color).toContain("40, 213, 143");
    expect(result[1]?.color).toContain("241, 83, 103");
    expect(result[2]?.color).toBe("rgba(0, 0, 0, 0)");
  });
});
