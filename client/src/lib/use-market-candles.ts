"use client";

import { useEffect, useState } from "react";
import { pnlxGet } from "@/lib/pnlx-api";
import type { ChartCandle } from "@/types/trading";

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "1d";

interface CandlesResponse {
  candles: ChartCandle[];
  fetchedAt: number;
  interval: CandleInterval;
  marketId: string;
  productId: string;
  realtime: boolean;
  source: string;
}

interface MarketCandlesState {
  candles: ChartCandle[];
  error?: string;
  loading: boolean;
  source?: string;
  updatedAt?: number;
}

const HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws";

const MARKET_COINS: Record<string, string> = {
  "btc-usd-perp": "BTC",
  "eth-usd-perp": "ETH",
  "sol-usd-perp": "SOL",
  "xlm-usd-perp": "XLM",
  "xrp-usd-perp": "XRP",
};

export function useMarketCandles(
  marketId: string | undefined,
  interval: CandleInterval,
  limit = 160,
): MarketCandlesState {
  const [state, setState] = useState<MarketCandlesState>({
    candles: [],
    loading: Boolean(marketId),
  });

  useEffect(() => {
    if (!marketId) {
      setState({ candles: [], loading: false });
      return;
    }

    const activeMarketId = marketId;
    const coin = MARKET_COINS[activeMarketId];
    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    async function loadSnapshot() {
      try {
        const response = await pnlxGet<CandlesResponse>(
          `/markets/candles?marketId=${encodeURIComponent(activeMarketId)}&interval=${interval}&limit=${limit}`,
        );
        if (!active) return;
        setState({
          candles: mergeCandles([], response.candles, limit),
          loading: false,
          source: response.source,
          updatedAt: response.fetchedAt,
        });
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
      if (!active || !coin || typeof WebSocket === "undefined") return;

      const subscription = {
        coin,
        interval,
        type: "candle",
      };
      socket = new WebSocket(HYPERLIQUID_WS_URL);
      socket.onopen = () => {
        socket?.send(JSON.stringify({ method: "subscribe", subscription }));
      };
      socket.onmessage = (event) => {
        const candle = candleFromMessage(event.data, coin, interval);
        if (!candle || !active) return;
        setState((current) => ({
          candles: upsertCandle(current.candles, candle, limit),
          error: undefined,
          loading: false,
          source: "hyperliquid-ws",
          updatedAt: Date.now(),
        }));
      };
      socket.onerror = () => {
        if (!active) return;
        setState((current) => ({
          ...current,
          error: current.candles.length > 0 ? undefined : "Live candle stream unavailable",
          loading: false,
        }));
      };
      socket.onclose = () => {
        if (!active) return;
        reconnectTimer = setTimeout(connectStream, 1_500);
      };
    }

    setState({
      candles: [],
      loading: true,
    });
    void loadSnapshot();
    connectStream();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          method: "unsubscribe",
          subscription: { coin, interval, type: "candle" },
        }));
      }
      socket?.close();
    };
  }, [interval, limit, marketId]);

  return state;
}

function candleFromMessage(
  raw: string,
  coin: string,
  interval: CandleInterval,
): ChartCandle | undefined {
  try {
    const message = JSON.parse(raw) as {
      channel?: string;
      data?: Record<string, unknown>;
    };
    if (message.channel !== "candle" || !message.data) return undefined;
    if (message.data.s !== coin || message.data.i !== interval) return undefined;

    return {
      close: finiteNumber(message.data.c),
      high: finiteNumber(message.data.h),
      low: finiteNumber(message.data.l),
      open: finiteNumber(message.data.o),
      time: new Date(finiteNumber(message.data.t)).toISOString(),
      volume: finiteNumber(message.data.v),
    };
  } catch {
    return undefined;
  }
}

function upsertCandle(
  candles: ChartCandle[],
  next: ChartCandle,
  limit: number,
): ChartCandle[] {
  return mergeCandles(candles, [next], limit);
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
