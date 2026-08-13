import { describe, expect, test } from "bun:test";
import {
  chooseLatestTick,
  mergeCandles,
  mergeSnapshotCandles,
  upsertPrice,
  type MarketPriceUpdate,
} from "@/lib/use-market-candles";
import type { ChartCandle } from "@/types/trading";

const first: ChartCandle = {
  close: 10,
  high: 11,
  low: 9,
  open: 9.5,
  time: "2026-08-13T10:00:00.000Z",
  volume: 4,
};

function tick(price: number, publishedAt: number): MarketPriceUpdate {
  return { confidence: 0.01, marketId: "xlm-usd-perp", price, publishedAt, source: "pyth-hermes" };
}

describe("market candle stream helpers", () => {
  test("folds ticks into the active OHLC bucket", () => {
    const lower = upsertPrice([first], tick(8, Date.parse("2026-08-13T10:00:30.000Z")), "1m");
    const higher = upsertPrice(lower, tick(12, Date.parse("2026-08-13T10:00:45.000Z")), "1m");
    expect(higher[0]).toEqual({ ...first, close: 12, high: 12, low: 8 });
  });

  test("opens a new bucket from the previous close", () => {
    const next = upsertPrice([first], tick(12, Date.parse("2026-08-13T10:01:01.000Z")), "1m");
    expect(next[1]).toMatchObject({ close: 12, high: 12, low: 10, open: 10 });
  });

  test("keeps the latest same-second tick and merges sorted history", () => {
    const older = tick(9, 1_000);
    const latest = tick(11, 1_000);
    expect(chooseLatestTick(older, latest)).toBe(latest);
    expect(mergeCandles([first], [{ ...first, close: 12 }])[0].close).toBe(12);
  });

  test("refreshes settlement volume without replacing the latest streamed price", () => {
    const snapshot = [{ ...first, close: 10, volume: 12.5 }];
    const current = [{ ...first, close: 12, high: 12, volume: 0 }];

    expect(mergeSnapshotCandles(snapshot, current)).toEqual([
      expect.objectContaining({ close: 12, high: 12, volume: 12.5 }),
    ]);
  });
});
