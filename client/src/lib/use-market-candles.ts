"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pnlxGet } from "@/lib/pnlx-api";
import type { ChartCandle } from "@/types/trading";

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "1d";
export type CandleTransport = "connecting" | "fallback" | "offline" | "stream";

interface CandlesResponse {
  cached?: boolean;
  candles: ChartCandle[];
  fetchedAt: number;
  from?: number;
  hasMore?: boolean;
  interval: CandleInterval;
  marketId: string;
  productId: string;
  realtime: boolean;
  source: string;
  stale?: boolean;
  to?: number;
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

export interface MarketPriceUpdate {
  confidence: number;
  marketId: string;
  price: number;
  publishedAt: number;
  source: "hyperliquid" | "pyth-hermes";
}

export interface SnapshotMergeOptions {
  interval?: CandleInterval;
  livePublishedAt?: number;
  stale?: boolean;
}

const MAX_RETAINED_CANDLES = 5_000;
const FALLBACK_POLL_MS = 5_000;
const SNAPSHOT_REFRESH_MS = 10_000;
const TICK_COALESCE_MS = 80;

export function useMarketCandles(
  marketId: string | undefined,
  interval: CandleInterval,
  limit = 300,
): MarketCandlesState {
  const [state, setState] = useState<Omit<MarketCandlesState, "loadOlder">>({
    candles: [],
    hasMore: true,
    live: false,
    loading: Boolean(marketId),
    loadingMore: false,
    transport: marketId ? "connecting" : "offline",
  });
  const loadingMoreRef = useRef(false);
  const scopeRef = useRef("");

  useEffect(() => {
    const scope = `${marketId ?? "none"}:${interval}`;
    scopeRef.current = scope;
    loadingMoreRef.current = false;
    if (!marketId) {
      setState({
        candles: [],
        hasMore: false,
        live: false,
        loading: false,
        loadingMore: false,
        transport: "offline",
      });
      return;
    }

    const activeMarketId = marketId;
    let active = true;
    let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
    let eventSource: EventSource | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let initialSnapshotSettled = false;
    let lastAppliedTickAt = 0;
    let snapshotTickFloor = 0;
    let snapshotRequestActive = false;
    let snapshotUpdates: MarketPriceUpdate[] = [];
    let pendingUpdate: MarketPriceUpdate | undefined;
    let lastAcceptedSignature = "";
    let streamOpen = false;

    function flushPendingUpdate() {
      coalesceTimer = undefined;
      if (!initialSnapshotSettled) return;
      const update = pendingUpdate;
      pendingUpdate = undefined;
      if (
        !active ||
        !isTickFlushable(update, initialSnapshotSettled, Math.max(lastAppliedTickAt, snapshotTickFloor))
      ) return;
      lastAppliedTickAt = update.publishedAt;
      setState((current) => ({
        ...current,
        candles: upsertPrice(current.candles, update, interval, MAX_RETAINED_CANDLES),
        error: undefined,
        live: true,
        loading: false,
        source: update.source,
        updatedAt: update.publishedAt,
      }));
    }

    function queuePrice(update: MarketPriceUpdate) {
      if (!isMarketPriceUpdate(update, activeMarketId)) return;
      const signature = `${update.publishedAt}:${update.price}:${update.confidence}`;
      if (signature === lastAcceptedSignature) return;
      lastAcceptedSignature = signature;
      if (snapshotRequestActive) {
        snapshotUpdates = bufferMonotonicTick(
          snapshotUpdates,
          update,
          Math.max(lastAppliedTickAt, snapshotTickFloor),
        );
      }
      pendingUpdate = chooseLatestTick(
        pendingUpdate,
        update,
        Math.max(lastAppliedTickAt, snapshotTickFloor),
      );
      if (!pendingUpdate) return;
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(flushPendingUpdate, TICK_COALESCE_MS);
    }

    async function loadSnapshot() {
      if (snapshotRequestActive) return;
      snapshotRequestActive = true;
      snapshotUpdates = pendingUpdate
        ? bufferMonotonicTick(
            [],
            pendingUpdate,
            Math.max(lastAppliedTickAt, snapshotTickFloor),
          )
        : [];
      try {
        const response = await pnlxGet<CandlesResponse>(
          `/markets/candles?marketId=${encodeURIComponent(activeMarketId)}&interval=${interval}&limit=${limit}`,
        );
        if (!active) return;
        const fetchedAt = positiveTimestamp(response.fetchedAt);
        const snapshotFloor = latestValidCandleTimestamp(response.candles);
        const replayUpdates = snapshotUpdates.filter(
          (update) => update.publishedAt >= snapshotFloor,
        );
        const livePublishedAtBeforeReplay = lastAppliedTickAt;
        const replayedAt = replayUpdates.at(-1)?.publishedAt ?? 0;
        snapshotUpdates = [];
        setState((current) => ({
          ...current,
          candles: replayPriceUpdates(
            mergeSnapshotCandles(
              response.candles,
              current.candles,
              MAX_RETAINED_CANDLES,
              {
                interval,
                livePublishedAt: livePublishedAtBeforeReplay,
                stale: response.stale,
              },
            ),
            replayUpdates,
            interval,
            MAX_RETAINED_CANDLES,
          ),
          error: undefined,
          hasMore: response.hasMore ?? response.candles.length >= limit,
          loading: false,
          source: replayUpdates.at(-1)?.source ?? response.source,
          updatedAt: Math.max(current.updatedAt ?? 0, fetchedAt, replayedAt),
        }));
        lastAppliedTickAt = Math.max(lastAppliedTickAt, replayedAt);
        snapshotTickFloor = Math.max(snapshotTickFloor, snapshotFloor);
        if (!initialSnapshotSettled) pendingUpdate = undefined;
      } catch (error) {
        if (!active) return;
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to load candles",
          loading: false,
        }));
      } finally {
        snapshotRequestActive = false;
        snapshotUpdates = [];
        if (active && !initialSnapshotSettled) {
          initialSnapshotSettled = true;
          if (pendingUpdate && !coalesceTimer) {
            coalesceTimer = setTimeout(flushPendingUpdate, 0);
          }
        }
      }
    }

    function scheduleFallback(delayMs = 0) {
      if (!active || streamOpen || fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined;
        void pollFallbackPrice();
      }, delayMs);
    }

    async function pollFallbackPrice() {
      if (!active || streamOpen) return;
      try {
        const update = await pnlxGet<MarketPriceUpdate>(
          `/markets/prices/latest?marketId=${encodeURIComponent(activeMarketId)}`,
        );
        if (!active || streamOpen) return;
        queuePrice(update);
        setState((current) => ({ ...current, live: true, transport: "fallback" }));
      } catch {
        if (!active || streamOpen) return;
        setState((current) => ({
          ...current,
          error: current.candles.length > 0 ? undefined : "Price unavailable",
          live: false,
          loading: false,
          transport: "offline",
        }));
      } finally {
        scheduleFallback(FALLBACK_POLL_MS);
      }
    }

    setState({
      candles: [],
      hasMore: true,
      live: false,
      loading: true,
      loadingMore: false,
      transport: "connecting",
    });
    void loadSnapshot();
    const snapshotRefreshTimer = setInterval(
      () => void loadSnapshot(),
      SNAPSHOT_REFRESH_MS,
    );

    if (typeof EventSource === "undefined") {
      scheduleFallback();
    } else {
      eventSource = new EventSource(
        `/api/pnlx/markets/prices/stream?marketId=${encodeURIComponent(activeMarketId)}`,
      );
      eventSource.addEventListener("open", () => {
        if (!active) return;
        streamOpen = true;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
        setState((current) => ({
          ...current,
          error: undefined,
          live: true,
          transport: "stream",
        }));
      });
      eventSource.addEventListener("price", (event) => {
        if (!active || !(event instanceof MessageEvent)) return;
        try {
          queuePrice(JSON.parse(event.data) as MarketPriceUpdate);
        } catch {
          // Ignore malformed upstream events; EventSource remains connected.
        }
      });
      eventSource.addEventListener("error", () => {
        if (!active) return;
        streamOpen = false;
        setState((current) => ({ ...current, live: false, transport: "fallback" }));
        scheduleFallback();
      });
    }

    return () => {
      active = false;
      eventSource?.close();
      if (coalesceTimer) clearTimeout(coalesceTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      clearInterval(snapshotRefreshTimer);
    };
  }, [interval, limit, marketId]);

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
        `/markets/candles?marketId=${encodeURIComponent(marketId)}&interval=${interval}` +
          `&limit=${limit}&from=${from}&to=${to}`,
      );
      if (scopeRef.current !== scope) return;
      const olderCandles = response.candles.filter((candle) => Date.parse(candle.time) < earliest);
      setState((current) => ({
        ...current,
        candles: mergeCandles(olderCandles, current.candles, MAX_RETAINED_CANDLES),
        error: undefined,
        hasMore: olderCandles.length > 0 && (response.hasMore ?? response.candles.length >= limit),
        loadingMore: false,
        source: response.source,
      }));
    } catch (error) {
      if (scopeRef.current !== scope) return;
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Unable to load older candles",
        loadingMore: false,
      }));
    } finally {
      loadingMoreRef.current = false;
    }
  }, [interval, limit, marketId, state.candles, state.hasMore]);

  return { ...state, loadOlder };
}

export function isMarketPriceUpdate(update: MarketPriceUpdate, marketId: string): boolean {
  if (update.marketId !== marketId) return false;
  if (update.source !== "pyth-hermes" && update.source !== "hyperliquid") return false;
  if (!Number.isFinite(update.price) || update.price <= 0) return false;
  return Number.isFinite(update.publishedAt) && update.publishedAt > 0;
}

export function chooseLatestTick(
  current: MarketPriceUpdate | undefined,
  candidate: MarketPriceUpdate,
  timestampFloor = 0,
): MarketPriceUpdate | undefined {
  if (candidate.publishedAt < timestampFloor) return current;
  if (!current) return candidate;
  if (candidate.publishedAt > current.publishedAt) return candidate;
  if (candidate.publishedAt === current.publishedAt) return candidate;
  return current;
}

export function isTickFlushable(
  update: MarketPriceUpdate | undefined,
  snapshotSettled: boolean,
  timestampFloor = 0,
): update is MarketPriceUpdate {
  return Boolean(
    snapshotSettled &&
    update &&
    Number.isFinite(update.publishedAt) &&
    update.publishedAt >= timestampFloor,
  );
}

export function bufferMonotonicTick(
  updates: MarketPriceUpdate[],
  candidate: MarketPriceUpdate,
  timestampFloor = 0,
): MarketPriceUpdate[] {
  const latestTimestamp = updates.at(-1)?.publishedAt ?? timestampFloor;
  if (
    !Number.isFinite(candidate.publishedAt) ||
    candidate.publishedAt < Math.max(timestampFloor, latestTimestamp)
  ) return updates;
  return [...updates, candidate];
}

export function replayPriceUpdates(
  candles: ChartCandle[],
  updates: MarketPriceUpdate[],
  interval: CandleInterval,
  limit = MAX_RETAINED_CANDLES,
): ChartCandle[] {
  return updates.reduce(
    (current, update) => upsertPrice(current, update, interval, limit),
    candles,
  );
}

export function upsertPrice(
  candles: ChartCandle[],
  update: MarketPriceUpdate,
  interval: CandleInterval,
  limit = MAX_RETAINED_CANDLES,
): ChartCandle[] {
  const validCandles = mergeCandles([], candles, limit);
  if (!Number.isFinite(update.price) || update.price <= 0) return validCandles;
  if (!Number.isFinite(update.publishedAt) || update.publishedAt <= 0) return validCandles;
  const intervalMs = intervalMilliseconds(interval);
  const bucket = Math.floor(update.publishedAt / intervalMs) * intervalMs;
  const time = new Date(bucket).toISOString();
  const existing = validCandles.find((candle) => candle.time === time);
  let previous: ChartCandle | undefined;
  for (let index = validCandles.length - 1; index >= 0; index -= 1) {
    if (Date.parse(validCandles[index].time) < bucket) {
      previous = validCandles[index];
      break;
    }
  }
  const adjacentPrevious = previous && Date.parse(previous.time) + intervalMs === bucket
    ? previous
    : undefined;
  const open = adjacentPrevious?.close ?? update.price;
  const next: ChartCandle = existing
    ? {
        ...existing,
        close: update.price,
        high: Math.max(existing.high, update.price),
        low: Math.min(existing.low, update.price),
      }
    : {
        close: update.price,
        high: Math.max(open, update.price),
        low: Math.min(open, update.price),
        open,
        time,
        volume: 0,
      };
  return mergeCandles(validCandles, [next], limit);
}

export function intervalMilliseconds(interval: CandleInterval): number {
  return {
    "1d": 86_400_000,
    "1h": 3_600_000,
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
  }[interval];
}

export function mergeCandles(
  base: ChartCandle[],
  updates: ChartCandle[],
  limit = MAX_RETAINED_CANDLES,
): ChartCandle[] {
  const byTime = new Map<string, ChartCandle>();
  for (const candle of base) {
    const normalized = normalizeCandle(candle);
    if (normalized) byTime.set(normalized.time, normalized);
  }
  for (const candle of updates) {
    const normalized = normalizeCandle(candle);
    if (normalized) byTime.set(normalized.time, normalized);
  }
  return [...byTime.values()]
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    .slice(-limit);
}

export function mergeSnapshotCandles(
  snapshot: ChartCandle[],
  current: ChartCandle[],
  limit = MAX_RETAINED_CANDLES,
  options: SnapshotMergeOptions = {},
): ChartCandle[] {
  const validSnapshot = mergeCandles([], snapshot, MAX_RETAINED_CANDLES);
  const validCurrent = mergeCandles([], current, MAX_RETAINED_CANDLES);
  if (validSnapshot.length === 0) return validCurrent.slice(-limit);

  const snapshotByTime = new Map(validSnapshot.map((candle) => [candle.time, candle]));
  if (options.stale) {
    const liveCandles = validCurrent.map((candle) => ({
      ...candle,
      volume: snapshotByTime.get(candle.time)?.volume ?? candle.volume,
    }));
    return mergeCandles(validSnapshot, liveCandles, limit);
  }

  const firstSnapshotAt = Date.parse(validSnapshot[0].time);
  const lastSnapshotAt = Date.parse(validSnapshot.at(-1)!.time);
  const livePublishedAt = positiveTimestamp(options.livePublishedAt);
  const liveBucket = options.interval && livePublishedAt > 0
    ? Math.floor(livePublishedAt / intervalMilliseconds(options.interval)) *
      intervalMilliseconds(options.interval)
    : 0;
  const merged = new Map(snapshotByTime);

  for (const candle of validCurrent) {
    const candleAt = Date.parse(candle.time);
    if (candleAt < firstSnapshotAt) {
      merged.set(candle.time, candle);
      continue;
    }
    if (candleAt > lastSnapshotAt && candleAt === liveBucket) {
      merged.set(candle.time, candle);
    }
  }

  return [...merged.values()]
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    .slice(-limit);
}

function normalizeCandle(candle: ChartCandle): ChartCandle | undefined {
  const time = Date.parse(candle.time);
  const open = finiteNumber(candle.open);
  const close = finiteNumber(candle.close);
  const high = finiteNumber(candle.high);
  const low = finiteNumber(candle.low);
  const volume = finiteNumber(candle.volume);
  if (
    !Number.isFinite(time) ||
    open === undefined ||
    close === undefined ||
    high === undefined ||
    low === undefined ||
    volume === undefined ||
    open <= 0 ||
    close <= 0 ||
    high <= 0 ||
    low <= 0 ||
    volume < 0 ||
    high < low ||
    high < open ||
    high < close ||
    low > open ||
    low > close
  ) return undefined;
  return { ...candle, close, high, low, open, time: new Date(time).toISOString(), volume };
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function positiveTimestamp(value: unknown): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function latestValidCandleTimestamp(candles: ChartCandle[]): number {
  const validCandles = mergeCandles([], candles, MAX_RETAINED_CANDLES);
  return validCandles.length > 0 ? Date.parse(validCandles.at(-1)!.time) : 0;
}
