import { describe, expect, test } from "bun:test";
import { intervalMilliseconds, isCandleUpdate, isFreshFeedCheck, mergeCandles, mergeOlderCandles, mergeSnapshotCandles, startMarketCandleFeed,
  type CandleUpdate, type CandlesResponse } from "@/lib/use-market-candles";
import type { ChartCandle } from "@/types/trading";

const startedAt = Date.parse("2026-08-13T10:00:30.000Z");
const input = { marketId: "xlm-usd-perp", interval: "1m" as const };
const first: ChartCandle = { close: 10, high: 11, low: 9, open: 9.5,
  time: "2026-08-13T10:00:00.000Z", trades: 4, volume: 4 };
function snapshot(now = startedAt, stale = false): CandlesResponse {
  return { ...input, candles: [first], fetchedAt: now, source: "hyperliquid", stale };
}
function update(candle = first, checkedAt = startedAt): CandleUpdate {
  return { ...input, candle, checkedAt, source: "hyperliquid" };
}
class TestSource extends EventTarget {
  closed = false;
  close() { this.closed = true; }
  emit(event: string, data: unknown) { this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) })); }
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await Bun.sleep(4);
  expect(check()).toBe(true);
}
function harness(load?: () => Promise<CandlesResponse>) {
  const state = { now: startedAt, requests: 0, live: false, candles: [] as ChartCandle[], sources: [] as TestSource[] };
  const stop = startMarketCandleFeed({ ...input, now: () => state.now,
    timing: { silence: 20, watchdog: 2, reconnect: 1, refresh: 1_000, fallback: 1_000 },
    loadSnapshot: async () => { state.requests++; return load ? load() : snapshot(state.now); },
    createSource: () => { const source = new TestSource(); state.sources.push(source); return source as unknown as EventSource; },
    onSnapshot(response) { state.candles = mergeSnapshotCandles(response.candles, state.candles); },
    onCandle(value) { state.candles = mergeCandles(state.candles, [value.candle]); },
    onHealth(value) { state.live = value; }, onError() {},
  });
  return { state, stop };
}

describe("native candle feed", () => {
  test("validates provider, market, interval, candle structure and verification age", () => {
    expect(isCandleUpdate(update(), input.marketId, input.interval, startedAt)).toBe(true);
    expect(isCandleUpdate({ ...update(), interval: "5m" }, input.marketId, input.interval, startedAt)).toBe(false);
    expect(isCandleUpdate(update(), "btc-usd-perp", input.interval, startedAt)).toBe(false);
    expect(isCandleUpdate(update({ ...first, high: 8 }), input.marketId, input.interval, startedAt)).toBe(false);
    expect(isCandleUpdate(update({ ...first, time: "2026-08-13T10:00:01.000Z" }), input.marketId, input.interval, startedAt)).toBe(false);
    expect(isFreshFeedCheck(startedAt - 25_001, startedAt)).toBe(false);
    expect(isFreshFeedCheck(startedAt + 5_001, startedAt)).toBe(false);
  });
  test("a lagging snapshot cannot roll back a native candle with more trades", () => {
    const live = { ...first, trades: 5, close: 12, high: 12 };
    expect(mergeSnapshotCandles([{ ...first, volume: 8 }], [live])).toEqual([{ ...live, volume: 8 }]);
    expect(mergeSnapshotCandles([{ ...live, trades: 6, close: 11 }], [live])[0].close).toBe(11);
  });
  test("retains history without inventing candles for empty periods", () => {
    const later = { ...first, time: "2026-08-13T10:05:00.000Z", open: 12, close: 12, high: 12, low: 12 };
    expect(mergeCandles([later], [first])).toEqual([first, later]);
    expect(mergeCandles([first], [{ ...first, close: 0 }, { ...first, time: "bad" }, { ...first, trades: -1 }])).toEqual([first]);
    expect(mergeSnapshotCandles([first], [{ ...first, close: 12, high: 12 }], 300, true)[0].close).toBe(12);
  });
  test("four-hour candles use four-hour boundaries and reject misaligned updates", () => {
    const now = Date.parse("2026-08-13T12:30:00.000Z");
    const aligned = { ...first, time: "2026-08-13T12:00:00.000Z" };
    const event: CandleUpdate = { ...update(aligned, now), interval: "4h" };
    expect(intervalMilliseconds("4h")).toBe(14_400_000);
    expect(isCandleUpdate(event, input.marketId, "4h", now)).toBe(true);
    expect(isCandleUpdate({ ...event, candle: { ...aligned, time: "2026-08-13T13:00:00.000Z" } },
      input.marketId, "4h", now + 3_600_000)).toBe(false);
  });
  test("history loading stops when the retained window cannot advance", () => {
    const candles = Array.from({ length: 5 }, (_, index) => ({
      ...first, time: new Date(startedAt + index * 60_000).toISOString(),
    }));
    const older = { ...first, time: new Date(startedAt - 60_000).toISOString() };
    expect(mergeOlderCandles(candles, [older], true, 5)).toEqual({ candles, hasMore: false });
    expect(mergeOlderCandles(candles, [candles[0]], true, 10)).toEqual({ candles, hasMore: false });
    const backfilled = mergeOlderCandles(candles, [older], true, 10);
    expect(backfilled.candles).toEqual([older, ...candles]);
    expect(backfilled.hasMore).toBe(true);
    expect(mergeOlderCandles(candles, [older], false, 10).hasMore).toBe(false);
  });
  test("open SSE and stale snapshots do not establish feed freshness", async () => {
    const { state, stop } = harness(async () => snapshot(startedAt, true));
    try {
      state.sources[0].dispatchEvent(new Event("open"));
      await Bun.sleep(5);
      expect(state.live).toBe(false);
      state.sources[0].emit("health", { ...input, checkedAt: state.now, source: "hyperliquid", available: true });
      expect(state.live).toBe(true);
    } finally { stop(); }
  });
  test("quiet markets stay healthy with genuine provider replies", async () => {
    const { state, stop } = harness();
    try {
      for (let i = 0; i < 4; i++) {
        state.now += 15;
        state.sources[0].emit("health", { ...input, checkedAt: state.now, source: "hyperliquid", available: true });
        await Bun.sleep(4);
      }
      expect(state.sources).toHaveLength(1);
      expect(state.sources[0].closed).toBe(false);
    } finally { stop(); }
  });
  test("silent connections reconnect and backfill while preserving history", async () => {
    const { state, stop } = harness();
    try {
      await waitFor(() => state.candles.length > 0);
      state.now += 21;
      await waitFor(() => state.sources.length > 1 && state.requests > 1);
      expect(state.sources[0].closed).toBe(true);
      expect(state.candles).toEqual([first]);
    } finally { stop(); }
  });
  test("a hung snapshot is aborted and retried", async () => {
    let requests = 0;
    let aborted = false;
    let candles: ChartCandle[] = [];
    const stop = startMarketCandleFeed({ ...input, now: () => startedAt,
      timing: { request: 5, fallback: 1, refresh: 1_000 },
      loadSnapshot(signal) {
        requests++;
        if (requests > 1) return Promise.resolve(snapshot());
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("request aborted"));
        }, { once: true }));
      },
      onSnapshot(response) { candles = response.candles; },
      onCandle() {}, onHealth() {}, onError() {},
    });
    try {
      await waitFor(() => candles.length > 0);
      expect(aborted).toBe(true);
      expect(requests).toBeGreaterThanOrEqual(2);
      expect(candles).toEqual([first]);
    } finally { stop(); }
  });
  test("replays native updates that arrive during a snapshot request", async () => {
    let release!: (response: CandlesResponse) => void;
    const { state, stop } = harness(() => new Promise((resolve) => { release = resolve; }));
    try {
      const live = { ...first, close: 12, high: 12, trades: 6 };
      state.sources[0].emit("candle", update(live));
      release(snapshot());
      await Bun.sleep(5);
      expect(state.candles[0].close).toBe(12);
      expect(state.candles[0].trades).toBe(6);
    } finally { stop(); }
  });
  test("late snapshots cannot update a disposed feed", async () => {
    let release!: (response: CandlesResponse) => void;
    const { state, stop } = harness(() => new Promise((resolve) => { release = resolve; }));
    stop(); release(snapshot());
    await Bun.sleep(5);
    expect(state.candles).toEqual([]);
  });
});
