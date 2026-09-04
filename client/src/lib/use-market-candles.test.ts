import { describe, expect, test } from "bun:test";
import {
  bufferMonotonicTick,
  chooseLatestTick,
  isMarketPriceUpdate,
  isTickFlushable,
  mergeCandles,
  mergeSnapshotCandles,
  replayPriceUpdates,
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
  test("accepts supported live price sources for the selected market", () => {
    const pythUpdate = tick(11, 2_000);
    const hyperliquidUpdate: MarketPriceUpdate = {
      ...pythUpdate,
      source: "hyperliquid",
    };

    expect(isMarketPriceUpdate(pythUpdate, "xlm-usd-perp")).toBe(true);
    expect(isMarketPriceUpdate(hyperliquidUpdate, "xlm-usd-perp")).toBe(true);
    expect(isMarketPriceUpdate(hyperliquidUpdate, "btc-usd-perp")).toBe(false);
    expect(isMarketPriceUpdate(
      { ...pythUpdate, source: "unsupported" } as unknown as MarketPriceUpdate,
      "xlm-usd-perp",
    )).toBe(false);
  });

  test("folds ticks into the active OHLC bucket", () => {
    const lower = upsertPrice([first], tick(8, Date.parse("2026-08-13T10:00:30.000Z")), "1m");
    const higher = upsertPrice(lower, tick(12, Date.parse("2026-08-13T10:00:45.000Z")), "1m");
    expect(higher[0]).toEqual({ ...first, close: 12, high: 12, low: 8 });
  });

  test("opens a new bucket from the previous close", () => {
    const next = upsertPrice([first], tick(12, Date.parse("2026-08-13T10:01:01.000Z")), "1m");
    expect(next[1]).toEqual({
      close: 12,
      high: 12,
      low: 10,
      open: 10,
      time: "2026-08-13T10:01:00.000Z",
      volume: 0,
    });
  });

  test("does not bridge a missing bucket with a stale prior close", () => {
    const next = upsertPrice([first], tick(12, Date.parse("2026-08-13T10:05:01.000Z")), "1m");
    expect(next[1]).toEqual({
      close: 12,
      high: 12,
      low: 12,
      open: 12,
      time: "2026-08-13T10:05:00.000Z",
      volume: 0,
    });
  });

  test("withholds ticks before snapshot settlement and across timestamp regressions", () => {
    const update = tick(11, 2_000);
    expect(isTickFlushable(update, false, 0)).toBe(false);
    expect(isTickFlushable(update, true, 2_001)).toBe(false);
    expect(isTickFlushable(update, true, 2_000)).toBe(true);
  });

  test("buffers equal or increasing ticks while rejecting timestamp regressions", () => {
    const firstUpdate = tick(11, 2_000);
    const sameTimestamp = tick(12, 2_000);
    const buffered = bufferMonotonicTick([], firstUpdate, 1_000);
    const withSameTimestamp = bufferMonotonicTick(buffered, sameTimestamp, 1_000);

    expect(withSameTimestamp).toEqual([firstUpdate, sameTimestamp]);
    expect(bufferMonotonicTick(withSameTimestamp, tick(8, 1_999), 1_000))
      .toBe(withSameTimestamp);
  });

  test("keeps the latest tick across coalescing windows and merges sorted history", () => {
    const older = tick(9, 1_000);
    const latest = tick(11, 1_000);
    expect(chooseLatestTick(older, latest)).toBe(latest);
    expect(chooseLatestTick(latest, tick(8, 999))).toBe(latest);
    expect(chooseLatestTick(undefined, tick(8, 999), 1_000)).toBeUndefined();
    expect(mergeCandles([first], [{ ...first, close: 12, high: 12 }])[0].close).toBe(12);
  });

  test("lets a fresh snapshot repair completed and matching OHLC", () => {
    const snapshot = [{ ...first, close: 10, volume: 12.5 }];
    const poisoned = [{ ...first, close: 12, high: 100, low: 1, open: 1, volume: 0 }];

    expect(mergeSnapshotCandles(snapshot, poisoned, 300, {
      interval: "1m",
      livePublishedAt: Date.parse("2026-08-13T10:00:45.000Z"),
    })).toEqual(snapshot);
  });

  test("keeps a fresh snapshot authoritative for an active matching candle", () => {
    const snapshot = [{ ...first, volume: 12.5 }];
    const poisoned = [{ ...first, close: 12, high: 100, low: 1, open: 1, volume: 0 }];

    expect(mergeSnapshotCandles(snapshot, poisoned, 300, {
      interval: "1m",
      livePublishedAt: Date.parse("2026-08-13T10:00:45.000Z"),
    })).toEqual(snapshot);
  });

  test("repairs old matching OHLC before replaying ticks received during refresh", () => {
    const snapshot = [{ ...first, volume: 12.5 }];
    const poisoned = [{ ...first, close: 12, high: 100, low: 1, open: 1, volume: 0 }];
    const receivedDuringRefresh = [
      tick(8, Date.parse("2026-08-13T10:00:41.000Z")),
      tick(12, Date.parse("2026-08-13T10:00:42.000Z")),
    ];
    const repaired = mergeSnapshotCandles(snapshot, poisoned, 300, {
      interval: "1m",
      livePublishedAt: Date.parse("2026-08-13T10:00:40.000Z"),
    });

    expect(replayPriceUpdates(repaired, receivedDuringRefresh, "1m", 300)).toEqual([{
      ...first,
      close: 12,
      high: 12,
      low: 8,
      volume: 12.5,
    }]);
  });

  test("preserves a structurally plausible active range and live tail", () => {
    const snapshot = [{
      ...first,
      time: "2026-08-13T09:59:00.000Z",
      volume: 12.5,
    }];
    const activeTail: ChartCandle = {
      close: 12,
      high: 12,
      low: 12,
      open: 12,
      time: "2026-08-13T10:00:00.000Z",
      volume: 0,
    };

    expect(mergeSnapshotCandles(snapshot, [activeTail], 300, {
      interval: "1m",
      livePublishedAt: Date.parse("2026-08-13T10:00:30.000Z"),
    })).toEqual([snapshot[0], activeTail]);
  });

  test("keeps live OHLC over a stale snapshot while refreshing its volume", () => {
    const snapshot = [{ ...first, volume: 12.5 }];
    const current = [{ ...first, close: 12, high: 12, volume: 0 }];

    expect(mergeSnapshotCandles(snapshot, current, 300, { stale: true })).toEqual([
      { ...current[0], volume: 12.5 },
    ]);
  });

  test("skips malformed, nonpositive, and inconsistent candles without throwing", () => {
    const invalidCandles: ChartCandle[] = [
      { ...first, time: "not-a-time" },
      { ...first, close: 0 },
      { ...first, high: 8 },
      { ...first, low: 12 },
      { ...first, volume: -1 },
      { ...first, open: Number.NaN },
    ];

    expect(mergeCandles([first], invalidCandles)).toEqual([first]);
    expect(upsertPrice([first], tick(0, Date.parse("2026-08-13T10:00:30.000Z")), "1m"))
      .toEqual([first]);
  });
});
