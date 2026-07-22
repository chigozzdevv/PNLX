"use client";

import { useEffect, useState } from "react";
import { pnlxGet } from "@/lib/pnlx-api";
import type { ChartCandle } from "@/types/trading";

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "1d";

interface CandlesResponse {
  cached?: boolean;
  candles: ChartCandle[];
  fetchedAt: number;
  interval: CandleInterval;
  marketId: string;
  productId: string;
  realtime: boolean;
  source: string;
  stale?: boolean;
}

interface MarketCandlesState {
  candles: ChartCandle[];
  error?: string;
  live: boolean;
  loading: boolean;
  source?: string;
  updatedAt?: number;
}

interface MarketPriceUpdate {
  confidence: number;
  marketId: string;
  price: number;
  publishedAt: number;
  source: "pyth-hermes";
}

export function useMarketCandles(
  marketId: string | undefined,
  interval: CandleInterval,
  limit = 160,
): MarketCandlesState {
  const [state, setState] = useState<MarketCandlesState>({
    candles: [],
    live: false,
    loading: Boolean(marketId),
  });

  useEffect(() => {
    if (!marketId) {
      setState({ candles: [], live: false, loading: false });
      return;
    }

    const activeMarketId = marketId;
    let active = true;
    let stream: EventSource | undefined;

    async function loadSnapshot() {
      try {
        const response = await pnlxGet<CandlesResponse>(
          `/markets/candles?marketId=${encodeURIComponent(activeMarketId)}&interval=${interval}&limit=${limit}`,
        );
        if (!active) return;
        setState((current) => ({
          ...current,
          candles: mergeCandles(response.candles, current.candles, limit),
          error: undefined,
          loading: false,
          source: response.source,
          updatedAt: response.fetchedAt,
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

    function connectStream() {
      if (!active || typeof EventSource === "undefined") return;
      const url = `/api/pnlx/markets/prices/stream?marketId=${encodeURIComponent(activeMarketId)}`;
      stream = new EventSource(url);
      stream.onopen = () => {
        if (!active) return;
        setState((current) => ({ ...current, error: undefined }));
      };
      stream.addEventListener("price", (event) => {
        const update = priceFromMessage(event.data, activeMarketId);
        if (!update || !active) return;
        setState((current) => ({
          candles: upsertPrice(current.candles, update, interval, limit),
          error: undefined,
          live: true,
          loading: false,
          source: update.source,
          updatedAt: Date.now(),
        }));
      });
      stream.onerror = () => {
        if (!active) return;
        setState((current) => ({
          ...current,
          error: current.candles.length > 0 ? undefined : "Live price stream reconnecting",
          live: false,
          loading: false,
        }));
      };
    }

    setState({
      candles: [],
      live: false,
      loading: true,
    });
    void loadSnapshot();
    connectStream();

    return () => {
      active = false;
      stream?.close();
    };
  }, [interval, limit, marketId]);

  return state;
}

function priceFromMessage(
  raw: string,
  marketId: string,
): MarketPriceUpdate | undefined {
  try {
    const update = JSON.parse(raw) as MarketPriceUpdate;
    if (update.marketId !== marketId || update.source !== "pyth-hermes") return undefined;
    if (!Number.isFinite(update.price) || update.price <= 0) return undefined;
    if (!Number.isFinite(update.publishedAt) || update.publishedAt <= 0) return undefined;
    return update;
  } catch {
    return undefined;
  }
}

function upsertPrice(
  candles: ChartCandle[],
  update: MarketPriceUpdate,
  interval: CandleInterval,
  limit: number,
): ChartCandle[] {
  const bucket = Math.floor(update.publishedAt / intervalMilliseconds(interval)) * intervalMilliseconds(interval);
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

function intervalMilliseconds(interval: CandleInterval): number {
  return {
    "1d": 86_400_000,
    "1h": 3_600_000,
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
  }[interval];
}

function mergeCandles(
  base: ChartCandle[],
  updates: ChartCandle[],
  limit: number,
): ChartCandle[] {
  const byTime = new Map(base.map((candle) => [candle.time, candle]));
  for (const candle of updates) {
    byTime.set(candle.time, normalizeCandle(candle));
  }
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
