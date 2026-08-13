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
  source: "pyth-hermes";
}

const MAX_RETAINED_CANDLES = 5_000;
const FALLBACK_POLL_MS = 5_000;
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
    let pendingUpdate: MarketPriceUpdate | undefined;
    let lastAcceptedSignature = "";
    let streamOpen = false;

    function flushPendingUpdate() {
      coalesceTimer = undefined;
      const update = pendingUpdate;
      pendingUpdate = undefined;
      if (!active || !update) return;
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
      pendingUpdate = chooseLatestTick(pendingUpdate, update);
      if (coalesceTimer) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(flushPendingUpdate, TICK_COALESCE_MS);
    }

    async function loadSnapshot() {
      try {
        const response = await pnlxGet<CandlesResponse>(
          `/markets/candles?marketId=${encodeURIComponent(activeMarketId)}&interval=${interval}&limit=${limit}`,
        );
        if (!active) return;
        setState((current) => ({
          ...current,
          candles: mergeCandles(response.candles, current.candles, MAX_RETAINED_CANDLES),
          error: undefined,
          hasMore: response.hasMore ?? response.candles.length >= limit,
          loading: false,
          source: response.source,
          updatedAt: Math.max(current.updatedAt ?? 0, response.fetchedAt),
        }));
      } catch (error) {
        if (!active) return;
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to load candles",
          loading: false,
        }));
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
          error: current.candles.length > 0 ? undefined : "Live price stream reconnecting",
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

function isMarketPriceUpdate(update: MarketPriceUpdate, marketId: string): boolean {
  if (update.marketId !== marketId || update.source !== "pyth-hermes") return false;
  if (!Number.isFinite(update.price) || update.price <= 0) return false;
  return Number.isFinite(update.publishedAt) && update.publishedAt > 0;
}

export function chooseLatestTick(
  current: MarketPriceUpdate | undefined,
  candidate: MarketPriceUpdate,
): MarketPriceUpdate {
  if (!current) return candidate;
  if (candidate.publishedAt > current.publishedAt) return candidate;
  if (candidate.publishedAt === current.publishedAt) return candidate;
  return current;
}

export function upsertPrice(
  candles: ChartCandle[],
  update: MarketPriceUpdate,
  interval: CandleInterval,
  limit = MAX_RETAINED_CANDLES,
): ChartCandle[] {
  const intervalMs = intervalMilliseconds(interval);
  const bucket = Math.floor(update.publishedAt / intervalMs) * intervalMs;
  const time = new Date(bucket).toISOString();
  const existing = candles.find((candle) => candle.time === time);
  const previousClose = candles.at(-1)?.close ?? update.price;
  const next: ChartCandle = existing
    ? {
        ...existing,
        close: update.price,
        high: Math.max(existing.high, update.price),
        low: Math.min(existing.low, update.price),
      }
    : {
        close: update.price,
        high: update.price,
        low: update.price,
        open: previousClose,
        time,
        volume: 0,
      };
  return mergeCandles(candles, [next], limit);
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
  const byTime = new Map(base.map((candle) => [candle.time, normalizeCandle(candle)]));
  for (const candle of updates) byTime.set(candle.time, normalizeCandle(candle));
  return [...byTime.values()]
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    .slice(-limit);
}

function normalizeCandle(candle: ChartCandle): ChartCandle {
  const open = finiteNumber(candle.open);
  const close = finiteNumber(candle.close);
  const high = Math.max(finiteNumber(candle.high), open, close);
  const low = Math.min(finiteNumber(candle.low), open, close);
  const volume = Math.max(0, finiteNumber(candle.volume));
  return { ...candle, close, high, low, open, volume };
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("invalid candle number");
  return number;
}
