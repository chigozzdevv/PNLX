import { describe, expect, test } from "bun:test";
import type { MarketConfig } from "@pnlx/protocol-types";
import { ProtocolStore } from "@/shared/state/store";
import { MarketRiskFunding } from "./market-risk-funding";

const XLM = "xlm-usd-perp";

describe("market risk funding cache", () => {
  test("uses config only in explicit development mode and fails closed without a production reader", async () => {
    const cache = new MarketRiskFunding(store(XLM), undefined, { now: () => 1_000 });
    expect(cache.snapshot(XLM, -5n, false)).toEqual({
      status: "available", source: "market-config", fundingIndex: -5n, updatedAt: 1_000,
    });
    expect(cache.snapshot(XLM, undefined as unknown as bigint, false)).toEqual({
      status: "unavailable", source: "market-config", fundingIndex: null, updatedAt: null,
    });
    await cache.refresh([XLM]);
    expect(cache.snapshot(XLM, 0n, true)).toEqual({
      status: "unavailable", source: "onchain-market", fundingIndex: null, updatedAt: null,
    });
  });

  test("shares and deduplicates reads per store, preserving verified zero and negative indexes", async () => {
    const state = store(XLM);
    let now = 1_000, calls = 0;
    const pending = deferred<bigint>();
    const reader = { marketFundingIndexAsync: () => { calls++; return pending.promise; } };
    const first = new MarketRiskFunding(state, reader, { now: () => now });
    const second = new MarketRiskFunding(state, reader, { now: () => now });
    const reads = [first.refresh([XLM, XLM]), second.refresh([XLM])];
    await until(() => calls === 1);
    pending.resolve(0n);
    await Promise.all(reads);
    expect(second.snapshot(XLM, 99n, true)).toEqual({
      status: "available", source: "onchain-market", fundingIndex: 0n, updatedAt: 1_000,
    });
    now += 14_999;
    await first.refresh([XLM]);
    expect(calls).toBe(1);
    now++;
    const refreshed = new MarketRiskFunding(state, { marketFundingIndexAsync: async () => { calls++; return -9n; } }, { now: () => now });
    await refreshed.refresh([XLM]);
    expect(calls).toBe(2);
    expect(first.snapshot(XLM, 0n, true).fundingIndex).toBe(-9n);
  });

  test("prioritizes XLM and limits actual reads to two across instances while draining other requested markets", async () => {
    const state = store("first", "second", XLM, "third");
    const jobs: Array<{ id: string; done: ReturnType<typeof deferred<bigint>> }> = [];
    let active = 0, peak = 0;
    const reader = { marketFundingIndexAsync: async (id: string) => {
      active++; peak = Math.max(peak, active);
      const done = deferred<bigint>(); jobs.push({ id, done });
      try { return await done.promise; } finally { active--; }
    } };
    const first = new MarketRiskFunding(state, reader), second = new MarketRiskFunding(state, reader);
    const work = [first.refresh(["first", "second", XLM]), second.refresh(["third", "not-configured"])];
    await until(() => jobs.length === 2);
    expect(jobs.map((job) => job.id)).toEqual([XLM, "first"]);
    expect(active).toBe(2);
    jobs[1].done.resolve(-2n);
    await until(() => jobs.length === 3);
    expect(jobs[2].id).toBe("second");
    jobs[0].done.resolve(0n);
    await until(() => jobs.length === 4);
    expect(jobs[3].id).toBe("third");
    jobs[2].done.resolve(3n); jobs[3].done.resolve(4n);
    await Promise.all(work);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  test("a failed refresh invalidates even a fresh cached value and backs off before recovery", async () => {
    let now = 1_000, calls = 0;
    const reader = { marketFundingIndexAsync: async () => {
      calls++;
      if (calls === 2) throw new Error("private RPC details must not be exposed");
      return calls === 1 ? 4n : -2n;
    } };
    const cache = new MarketRiskFunding(store(XLM), reader, { now: () => now });
    await cache.refresh([XLM]);
    expect(cache.snapshot(XLM, 0n, true).fundingIndex).toBe(4n);
    now += 15_000;
    await cache.refresh([XLM]);
    expect(cache.snapshot(XLM, 55n, true)).toEqual({
      status: "unavailable", source: "onchain-market", fundingIndex: null, updatedAt: 1_000,
    });
    now += 29_999;
    await cache.refresh([XLM]);
    expect(calls).toBe(2);
    now++;
    await cache.refresh([XLM]);
    expect(cache.snapshot(XLM, 0n, true).fundingIndex).toBe(-2n);
    now += 60_001;
    expect(cache.snapshot(XLM, 0n, true).status).toBe("unavailable");
  });

  test("timeout does not free an underlying RPC lease or accept its late value", async () => {
    let now = 1_000, active = 0, peak = 0;
    const jobs: Array<{ id: string; done: ReturnType<typeof deferred<bigint>> }> = [];
    const reader = { marketFundingIndexAsync: async (id: string) => {
      active++; peak = Math.max(peak, active);
      const done = deferred<bigint>(); jobs.push({ id, done });
      try { return await done.promise; } finally { active--; }
    } };
    const cache = new MarketRiskFunding(store(XLM, "other", "waiting"), reader,
      { now: () => now, timeoutMs: 10, retryMs: 1, refreshMs: 1 });
    await cache.refresh([XLM, "other"]);
    expect(jobs).toHaveLength(2);
    expect(active).toBe(2);
    expect(cache.snapshot(XLM, 0n, true).status).toBe("unavailable");
    now += 5;
    await cache.refresh([XLM, "other"]);
    expect(jobs).toHaveLength(2);
    const waiting = cache.refresh(["waiting"]);
    await tick();
    expect(jobs).toHaveLength(2);
    jobs[0].done.resolve(77n);
    await until(() => jobs.length === 3);
    expect(jobs[2].id).toBe("waiting");
    expect(cache.snapshot(XLM, 0n, true).fundingIndex).toBeNull();
    jobs[1].done.reject(new Error("late failure"));
    jobs[2].done.resolve(-3n);
    await waiting;
    expect(cache.snapshot("waiting", 0n, true).fundingIndex).toBe(-3n);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  test("a malformed reader result cannot become a fabricated funding index", async () => {
    const cache = new MarketRiskFunding(store(XLM), { marketFundingIndexAsync: async () => undefined as unknown as bigint });
    await cache.refresh([XLM]);
    expect(cache.snapshot(XLM, 0n, true).fundingIndex).toBeNull();
  });
});

function store(...marketIds: string[]): ProtocolStore {
  const result = new ProtocolStore();
  for (const marketId of marketIds) result.markets.set(marketId, { marketId } as MarketConfig);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function tick(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)); }

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for funding reads");
    await tick();
  }
}
