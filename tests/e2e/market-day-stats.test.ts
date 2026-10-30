import { describe, expect, test } from "bun:test";
import { MarketDayStatsService, parseMarketDayStats } from "@/features/markets/market-day-stats";
import { MarketsService } from "@/features/markets/markets.service";
import { registerMarketsRoute } from "@/features/markets/markets.route";
import { Router } from "@/shared/http/router";
import { ExecutorService } from "@/workers/executor/executor.service";
import { loadEnv } from "@/config/env";

const MARKET = "xlm-usd-perp";
const MINUTE = 60_000;
const DAY = 86_400_000;
const AS_OF = Date.parse("2026-10-30T12:34:00.000Z");

function rows(asOf = AS_OF) {
  return Array.from({ length: 1_440 }, (_, index) => ({
    s: "XLM", i: "1m", t: asOf - DAY + index * MINUTE, T: asOf - DAY + (index + 1) * MINUTE - 1,
    o: "10", h: index === 1_439 ? "13" : "12", l: "9", c: index === 1_439 ? "12" : "11", n: 2, v: "3",
  }));
}

describe("rolling 24h reference market statistics", () => {
  test("all three statistics share exactly 1440 native completed minute candles", () => {
    const stats = parseMarketDayStats(rows(), MARKET, "XLM", AS_OF - DAY, AS_OF, AS_OF + 30_000);
    expect(stats).toEqual({ marketId: MARKET, source: "hyperliquid", interval: "1m", from: AS_OF - DAY,
      asOf: AS_OF, fetchedAt: AS_OF + 30_000, change24h: 20, high24h: 13, low24h: 9,
      open24h: 10, lastPrice: 12, stale: false });
  });

  test("neighbouring and unfinished candles cannot contaminate extrema or change", () => {
    const payload = rows();
    payload.unshift({ ...payload[0], t: AS_OF - DAY - MINUTE, T: AS_OF - DAY - 1, h: "99999", l: "0.00001" });
    payload.push({ ...payload[0], t: AS_OF, T: AS_OF + MINUTE - 1, h: "9999999", l: "0.000001", c: "500" });
    const stats = parseMarketDayStats(payload, MARKET, "XLM", AS_OF - DAY, AS_OF, AS_OF);
    expect([stats.change24h, stats.high24h, stats.low24h, stats.lastPrice]).toEqual([20, 13, 9, 12]);
  });

  test("rejects missing, duplicate, unordered, misaligned and wrong-source candles", () => {
    const mutations: Array<(payload: ReturnType<typeof rows>) => void> = [
      (payload) => { payload.splice(700, 1); },
      (payload) => { payload[700] = { ...payload[699] }; },
      (payload) => { [payload[5], payload[6]] = [payload[6], payload[5]]; },
      (payload) => { payload[100].t++; },
      (payload) => { payload[100].T--; },
      (payload) => { payload[100].s = "BTC"; },
      (payload) => { payload[100].i = "5m"; },
    ];
    for (const mutate of mutations) {
      const payload = rows(); mutate(payload);
      expect(() => parseMarketDayStats(payload, MARKET, "XLM", AS_OF - DAY, AS_OF, AS_OF)).toThrow();
    }
  });

  test("rejects invalid OHLC and invalid windows instead of returning partial statistics", () => {
    for (const patch of [{ o: "0" }, { h: "1" }, { l: "11" }, { c: "NaN" }, { c: "0xff" }, { h: "Infinity" }]) {
      const payload = rows(); Object.assign(payload[12], patch);
      expect(() => parseMarketDayStats(payload, MARKET, "XLM", AS_OF - DAY, AS_OF, AS_OF)).toThrow();
    }
    expect(() => parseMarketDayStats(rows(), MARKET, "XLM", AS_OF - DAY + MINUTE, AS_OF, AS_OF)).toThrow("time window");
    expect(() => parseMarketDayStats(rows(), MARKET, "XLM", AS_OF - DAY, AS_OF, AS_OF - 1)).toThrow("time window");
    expect(() => parseMarketDayStats([], MARKET, "XLM", AS_OF - DAY, AS_OF, AS_OF)).toThrow("coverage");
  });

  test("uses one correctly bounded provider request and reuses its verified window", async () => {
    let now = AS_OF + 10_000;
    const requests: RequestInit[] = [];
    const service = new MarketDayStatsService(async (_url, init) => {
      requests.push(init); return Response.json(rows(Math.floor(now / MINUTE) * MINUTE));
    }, () => now);
    const first = await service.stats(MARKET);
    now += 20_000;
    expect(await service.stats(MARKET)).toEqual(first);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0].body))).toEqual({ type: "candleSnapshot", req: {
      coin: "XLM", interval: "1m", startTime: AS_OF - DAY, endTime: AS_OF - 1,
    } });
    now = AS_OF + MINUTE + 5_000;
    expect((await service.stats(MARKET)).asOf).toBe(AS_OF + MINUTE);
    expect(requests).toHaveLength(2);
  });

  test("coalesces concurrent requests for the same market and window", async () => {
    let calls = 0;
    let release!: (response: Response) => void;
    const service = new MarketDayStatsService(() => {
      calls++; return new Promise((resolve) => { release = resolve; });
    }, () => AS_OF + 30_000);
    const first = service.stats(MARKET), second = service.stats(MARKET);
    expect(calls).toBe(1);
    release(Response.json(rows()));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.stale).toBe(false);
  });

  test("provider failures and incomplete replacements retain the last verified snapshot as stale", async () => {
    let now = AS_OF + 10_000;
    let mode: "good" | "http-error" | "incomplete" = "good";
    const service = new MarketDayStatsService(async () => mode === "http-error"
      ? new Response("unavailable", { status: 503 })
      : Response.json(mode === "incomplete" ? rows(AS_OF + MINUTE).slice(1) : rows()), () => now);
    const verified = await service.stats(MARKET);
    now += MINUTE; mode = "http-error";
    expect(await service.stats(MARKET)).toEqual({ ...verified, stale: true });
    mode = "incomplete";
    expect(await service.stats(MARKET)).toEqual({ ...verified, stale: true });
  });

  test("does not manufacture a zero snapshot when no verified source exists", async () => {
    let calls = 0;
    const service = new MarketDayStatsService(async () => { calls++; throw new Error("provider offline"); }, () => AS_OF);
    await expect(service.stats(MARKET)).rejects.toThrow("provider offline");
    await expect(service.stats("unsupported-usd-perp")).rejects.toThrow("unsupported");
    expect(calls).toBe(1);
  });

  test("a slow older request cannot overwrite a newer verified cache entry", async () => {
    let now = AS_OF + 10_000;
    const pending: Array<(response: Response) => void> = [];
    const service = new MarketDayStatsService(() => new Promise((resolve) => { pending.push(resolve); }), () => now);
    const older = service.stats(MARKET);
    now += MINUTE;
    const newer = service.stats(MARKET);
    pending[1](Response.json(rows(AS_OF + MINUTE)));
    const latest = await newer;
    pending[0](Response.json(rows()));
    expect((await older).stale).toBe(true);
    expect(await service.stats(MARKET)).toEqual(latest);
  });

  test("GET /markets/stats returns the reference snapshot through the registered route", async () => {
    const stats = new MarketDayStatsService(async () => Response.json(rows()), () => AS_OF + 30_000);
    const executor = new ExecutorService({});
    const env = loadEnv();
    const oracle = {} as never;
    const markets = new MarketsService(executor, oracle, env, undefined, undefined, undefined, stats);
    const router = new Router();
    registerMarketsRoute(router, executor, oracle, env, undefined, markets);
    const response = await router.handle(new Request(`http://pnlx.test/markets/stats?marketId=${MARKET}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ marketId: MARKET, source: "hyperliquid", interval: "1m",
      asOf: AS_OF, from: AS_OF - DAY, change24h: 20, high24h: 13, low24h: 9, stale: false });
    const missing = await router.handle(new Request("http://pnlx.test/markets/stats"));
    expect(await missing.json()).toEqual({ error: "marketId is required" });
  });
});
