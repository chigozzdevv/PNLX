"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pnlxGet } from "@/lib/pnlx-api";
import { apiPath } from "@/lib/api-path";
import type { ChartCandle } from "@/types/trading";

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "1d";
export type CandleTransport = "connecting" | "fallback" | "offline" | "stream";

export interface CandlesResponse {
  candles: ChartCandle[];
  fetchedAt: number;
  hasMore?: boolean;
  interval: CandleInterval;
  marketId: string;
  source: string;
  stale?: boolean;
}

export interface MarketCandlesState {
  candles: ChartCandle[];
  error?: string;
  hasMore: boolean;
  live: boolean;
  loadOlder: () => Promise<void>;
  loading: boolean;
  loadingMore: boolean;
  source?: string;
  transport: CandleTransport;
  updatedAt?: number;
}

export interface CandleUpdate {
  candle: ChartCandle;
  checkedAt: number;
  interval: CandleInterval;
  marketId: string;
  source: "hyperliquid";
}

const MAX_RETAINED_CANDLES = 5_000;
const FEED_SILENCE_MS = 25_000;

export function useMarketCandles(marketId: string | undefined, interval: CandleInterval, limit = 300): MarketCandlesState {
  const scope = `${marketId ?? "none"}:${interval}`;
  const [state, setState] = useState(() => emptyCandleState(scope, Boolean(marketId)));
  if (state.scope !== scope) setState(emptyCandleState(scope, Boolean(marketId)));
  const scopeRef = useRef("");
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    const scope = `${marketId ?? "none"}:${interval}`;
    scopeRef.current = scope;
    loadingMoreRef.current = false;
    if (!marketId) return;
    return startMarketCandleFeed({
      marketId, interval,
      loadSnapshot: (signal) => pnlxGet<CandlesResponse>(
        `/markets/candles?marketId=${encodeURIComponent(marketId)}&interval=${interval}&limit=${limit}`,
        undefined, signal,
      ),
      createSource: typeof EventSource === "undefined" ? undefined : () => new EventSource(
        `${apiPath("markets/candles/stream")}?marketId=${encodeURIComponent(marketId)}&interval=${interval}`,
      ),
      onSnapshot: (response) => setState((current) => ({
        ...current,
        candles: mergeSnapshotCandles(response.candles, current.candles, MAX_RETAINED_CANDLES, Boolean(response.stale)),
        error: undefined, loading: false, source: response.source,
        hasMore: response.hasMore ?? response.candles.length >= limit,
        updatedAt: Math.max(current.updatedAt ?? 0, response.fetchedAt),
      })),
      onCandle: (update) => setState((current) => ({
        ...current, candles: mergeCandles(current.candles, [update.candle]),
        error: undefined, loading: false, source: update.source,
        updatedAt: Math.max(current.updatedAt ?? 0, update.checkedAt),
      })),
      onHealth: (live, transport) => setState((current) => ({ ...current, live, transport })),
      onError: () => setState((current) => ({
        ...current, loading: false, error: current.candles.length > 0 ? undefined : "Unable to load candles",
      })),
    });
  }, [marketId, interval, limit]);

  const loadOlder = useCallback(async () => {
    if (!marketId || loadingMoreRef.current || !state.hasMore || state.candles.length === 0) return;
    const scope = `${marketId}:${interval}`;
    const earliest = Date.parse(state.candles[0].time);
    if (!Number.isFinite(earliest)) return;
    const to = Math.floor(earliest / 1_000) - 1;
    const from = Math.max(1, to - intervalMilliseconds(interval) / 1_000 * limit);
    loadingMoreRef.current = true;
    setState((current) => ({ ...current, loadingMore: true }));
    try {
      const response = await pnlxGet<CandlesResponse>(
        `/markets/candles?marketId=${encodeURIComponent(marketId)}&interval=${interval}&limit=${limit}&from=${from}&to=${to}`,
        undefined, AbortSignal.timeout(15_000),
      );
      if (scopeRef.current !== scope || response.source !== "hyperliquid") return;
      const older = response.candles.filter((candle) => Date.parse(candle.time) < earliest);
      setState((current) => ({
        ...current, candles: mergeCandles(older, current.candles), error: undefined, loadingMore: false,
        hasMore: older.length > 0 && (response.hasMore ?? response.candles.length >= limit),
      }));
    } catch {
      if (scopeRef.current === scope) setState((current) => ({ ...current, loadingMore: false }));
    } finally {
      if (scopeRef.current === scope) {
        loadingMoreRef.current = false;
        setState((current) => current.loadingMore ? { ...current, loadingMore: false } : current);
      }
    }
  }, [interval, limit, marketId, state.candles, state.hasMore]);
  return { ...state, loadOlder };
}

function emptyCandleState(scope: string, loading: boolean): Omit<MarketCandlesState, "loadOlder"> & { scope: string } {
  return { scope, candles: [], hasMore: true, live: false, loading, loadingMore: false,
    transport: loading ? "connecting" : "offline" };
}

interface CandleFeedOptions {
  marketId: string;
  interval: CandleInterval;
  loadSnapshot: (signal: AbortSignal) => Promise<CandlesResponse>;
  createSource?: () => EventSource;
  onSnapshot: (response: CandlesResponse) => void;
  onCandle: (update: CandleUpdate) => void;
  onHealth: (live: boolean, transport: CandleTransport) => void;
  onError: () => void;
  now?: () => number;
  timing?: { silence?: number; watchdog?: number; fallback?: number; refresh?: number; reconnect?: number; request?: number };
}

export function startMarketCandleFeed(options: CandleFeedOptions): () => void {
  const now = options.now ?? Date.now;
  const silenceMs = options.timing?.silence ?? FEED_SILENCE_MS;
  let active = true;
  let source: EventSource | undefined;
  let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let fetching = false;
  let snapshotAbort: AbortController | undefined;
  let refreshRequested = false;
  let lastStreamCheck = 0;
  let lastSnapshotCheck = 0;
  let streamHealthy = false;
  let connectedAt = 0;
  let reconnectMs = options.timing?.reconnect ?? 1_000;
  let buffered = new Map<string, CandleUpdate>();

  function reportHealth() {
    const streaming = streamHealthy && now() - lastStreamCheck <= silenceMs;
    const live = streaming || (lastSnapshotCheck > 0 && now() - lastSnapshotCheck <= silenceMs);
    options.onHealth(live, streaming ? "stream" : live ? "fallback" : "offline");
  }
  function scheduleSnapshot(delay: number) {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => { snapshotTimer = undefined; void refresh(); }, delay);
  }
  async function refresh() {
    if (!active) return;
    if (fetching) { refreshRequested = true; return; }
    fetching = true;
    const controller = new AbortController();
    snapshotAbort = controller;
    const timeout = setTimeout(() => controller.abort(), options.timing?.request ?? 15_000);
    buffered = new Map();
    try {
      const response = await options.loadSnapshot(controller.signal);
      if (!active) return;
      if (response.marketId !== options.marketId || response.interval !== options.interval || response.source !== "hyperliquid") {
        throw new Error("unexpected candle source");
      }
      options.onSnapshot(response);
      for (const update of buffered.values()) options.onCandle(update);
      if (!response.stale && isFreshFeedCheck(response.fetchedAt, now(), silenceMs)) lastSnapshotCheck = response.fetchedAt;
    } catch {
      if (active) options.onError();
    } finally {
      clearTimeout(timeout);
      snapshotAbort = undefined;
      fetching = false;
      if (active) {
        reportHealth();
        scheduleSnapshot(refreshRequested ? 0 : streamHealthy
          ? options.timing?.refresh ?? 10_000 : options.timing?.fallback ?? 5_000);
        refreshRequested = false;
      }
    }
  }
  function reconnect() {
    source?.close();
    source = undefined;
    streamHealthy = false;
    reportHealth();
    if (!active || !options.createSource || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, 15_000);
    void refresh();
  }
  function connect() {
    if (!active || !options.createSource) return;
    let next: EventSource;
    try { next = options.createSource(); } catch { reconnect(); return; }
    source = next;
    connectedAt = now();
    next.addEventListener("open", () => {
      if (active && source === next) void refresh();
    });
    next.addEventListener("health", (event) => {
      if (!active || source !== next || !(event instanceof MessageEvent)) return;
      try {
        const health = JSON.parse(event.data) as CandleUpdate & { available: boolean };
        if (!matchesFeed(health, options) || typeof health.available !== "boolean" ||
          !isFreshFeedCheck(health.checkedAt, now(), silenceMs)) return;
        const recovered = !streamHealthy && health.available;
        lastStreamCheck = health.checkedAt;
        streamHealthy = health.available;
        reportHealth();
        if (recovered) { reconnectMs = options.timing?.reconnect ?? 1_000; void refresh(); }
        else if (!streamHealthy) void refresh();
      } catch { /* Ignore malformed stream events. */ }
    });
    next.addEventListener("candle", (event) => {
      if (!active || source !== next || !(event instanceof MessageEvent)) return;
      try {
        const update = JSON.parse(event.data) as CandleUpdate;
        if (!isCandleUpdate(update, options.marketId, options.interval, now(), silenceMs)) return;
        lastStreamCheck = update.checkedAt;
        streamHealthy = true;
        reconnectMs = options.timing?.reconnect ?? 1_000;
        if (fetching) buffered.set(update.candle.time, update);
        options.onCandle(update);
        reportHealth();
      } catch { /* Ignore malformed stream events. */ }
    });
    next.addEventListener("error", () => {
      if (active && source === next) reconnect();
    });
  }
  const watchdog = setInterval(() => {
    if (!active) return;
    if (source && now() - Math.max(connectedAt, lastStreamCheck) > silenceMs) reconnect();
    reportHealth();
  }, options.timing?.watchdog ?? 2_000);
  void refresh();
  connect();
  return () => {
    active = false;
    snapshotAbort?.abort();
    source?.close();
    clearInterval(watchdog);
    if (snapshotTimer) clearTimeout(snapshotTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}

function matchesFeed(update: Pick<CandleUpdate, "marketId" | "interval" | "source">, input: { marketId: string; interval: CandleInterval }): boolean {
  return update?.marketId === input.marketId && update.interval === input.interval && update.source === "hyperliquid";
}

export function isFreshFeedCheck(checkedAt: number, now: number, maxAge = FEED_SILENCE_MS): boolean {
  return Number.isSafeInteger(checkedAt) && checkedAt > 0 && checkedAt <= now + 5_000 && now - checkedAt <= maxAge;
}

export function isCandleUpdate(update: CandleUpdate, marketId: string, interval: CandleInterval, now: number, maxAge = FEED_SILENCE_MS): boolean {
  const candle = update?.candle && normalizeCandle(update.candle);
  return matchesFeed(update, { marketId, interval }) && isFreshFeedCheck(update.checkedAt, now, maxAge) &&
    Boolean(candle && Date.parse(candle.time) % intervalMilliseconds(interval) === 0 && Date.parse(candle.time) <= now);
}

export function intervalMilliseconds(interval: CandleInterval): number {
  return { "1d": 86_400_000, "1h": 3_600_000, "1m": 60_000, "5m": 300_000, "15m": 900_000 }[interval];
}

export function mergeCandles(base: ChartCandle[], updates: ChartCandle[], limit = MAX_RETAINED_CANDLES): ChartCandle[] {
  const byTime = new Map<string, ChartCandle>();
  for (const input of [...base, ...updates]) {
    const candle = normalizeCandle(input);
    if (!candle) continue;
    const existing = byTime.get(candle.time);
    const next = existing && existing.trades !== undefined && candle.trades !== undefined && existing.trades > candle.trades
      ? existing : candle;
    byTime.set(candle.time, { ...next, volume: Math.max(existing?.volume ?? 0, candle.volume) });
  }
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-limit);
}

export function mergeSnapshotCandles(snapshot: ChartCandle[], current: ChartCandle[], limit = MAX_RETAINED_CANDLES, stale = false): ChartCandle[] {
  if (!stale) return mergeCandles(current, snapshot, limit);
  const volumes = new Map(snapshot.map((candle) => [candle.time, candle.volume]));
  return mergeCandles(snapshot, current.map((candle) => ({ ...candle, volume: volumes.get(candle.time) ?? candle.volume })), limit);
}

function normalizeCandle(candle: ChartCandle): ChartCandle | undefined {
  const time = Date.parse(candle.time);
  if (!Number.isFinite(time) || ![candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite) ||
    candle.open <= 0 || candle.close <= 0 || candle.high <= 0 || candle.low <= 0 || candle.volume < 0 ||
    candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) ||
    (candle.trades !== undefined && (!Number.isSafeInteger(candle.trades) || candle.trades < 0))) return undefined;
  return { ...candle, time: new Date(time).toISOString() };
}
