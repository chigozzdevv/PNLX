"use client";

import { useEffect, useMemo, useState } from "react";
import { pnlxGet } from "@/lib/pnlx-api";
import type { TickerItem } from "@/types/trading";

interface TickerResponse {
  ticker: Array<{
    change24h: number;
    pair: string;
    price?: number;
  }>;
  fetchedAt?: number;
}

interface MarketTickerState {
  live: boolean;
  ticker: TickerItem[];
  updatedAt?: number;
}

const HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws";
const TICKER_REFRESH_MS = 15_000;
const DEFAULT_TICKER: TickerItem[] = [
  { change: 0, pair: "XLM/USD" },
  { change: 0, pair: "BTC/USD" },
  { change: 0, pair: "BNB/USD" },
  { change: 0, pair: "SOL/USD" },
  { change: 0, pair: "ETH/USD" },
  { change: 0, pair: "XRP/USD" },
  { change: 0, pair: "ADA/USD" },
  { change: 0, pair: "DOGE/USD" },
  { change: 0, pair: "AVAX/USD" },
  { change: 0, pair: "LINK/USD" },
  { change: 0, pair: "LTC/USD" },
  { change: 0, pair: "ATOM/USD" },
];
const PAIR_ORDER = new Map(DEFAULT_TICKER.map((item, index) => [item.pair, index]));

export function useMarketTicker(fallback: TickerItem[]): MarketTickerState {
  const fallbackKey = useMemo(
    () => fallback.map((item) => `${item.pair}:${item.change}:${item.lastPrice ?? ""}`).join("|"),
    [fallback],
  );
  const fallbackTicker = useMemo(
    () => mergeTicker(DEFAULT_TICKER, fallback),
    [fallback],
  );
  const [state, setState] = useState<MarketTickerState>({
    live: false,
    ticker: sortTicker(fallbackTicker),
  });

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const response = await pnlxGet<TickerResponse>("/markets/ticker");
        if (!active) return;
        setState((current) => ({
          ...current,
          ticker: mergeTicker(
            current.ticker,
            response.ticker.map((item) => ({
              change: item.change24h,
              lastPrice: item.price,
              pair: item.pair,
            })),
          ),
          updatedAt: response.fetchedAt ?? Date.now(),
        }));
      } catch {
        if (active) {
          setState((current) => ({
            ...current,
            ticker: current.ticker.length > 0 ? current.ticker : sortTicker(fallbackTicker),
          }));
        }
      } finally {
        if (active) timer = setTimeout(load, TICKER_REFRESH_MS);
      }
    }

    void load();

    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [fallbackKey, fallbackTicker]);

  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    const coins = coinsFromTicker(fallbackTicker);
    let active = true;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocket | undefined;

    function connect() {
      if (!active) return;
      socket = new WebSocket(HYPERLIQUID_WS_URL);
      socket.onopen = () => {
        for (const coin of coins) {
          socket?.send(JSON.stringify({
            method: "subscribe",
            subscription: { coin, type: "activeAssetCtx" },
          }));
        }
      };
      socket.onmessage = (event) => {
        const item = tickerFromMessage(event.data);
        if (!item || !active) return;
        setState((current) => ({
          live: true,
          ticker: mergeTicker(current.ticker, [item]),
          updatedAt: Date.now(),
        }));
      };
      socket.onclose = () => {
        if (!active) return;
        setState((current) => ({ ...current, live: false }));
        reconnectTimer = setTimeout(connect, 1_500);
      };
      socket.onerror = () => {
        if (!active) return;
        setState((current) => ({ ...current, live: false }));
      };
    }

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket?.readyState === WebSocket.OPEN) {
        for (const coin of coins) {
          socket.send(JSON.stringify({
            method: "unsubscribe",
            subscription: { coin, type: "activeAssetCtx" },
          }));
        }
      }
      socket?.close();
    };
  }, [fallbackKey, fallbackTicker]);

  return state;
}

function tickerFromMessage(raw: unknown): TickerItem | undefined {
  if (typeof raw !== "string") return undefined;

  try {
    const message = JSON.parse(raw) as {
      channel?: string;
      data?: {
        coin?: string;
        ctx?: Record<string, unknown>;
      };
    };
    if (message.channel !== "activeAssetCtx" || !message.data?.coin || !message.data.ctx) {
      return undefined;
    }

    const price = firstFinite([message.data.ctx.markPx, message.data.ctx.midPx, message.data.ctx.oraclePx]);
    const previous = firstFinite([message.data.ctx.prevDayPx]);
    return {
      change: previous && previous > 0 ? ((price - previous) / previous) * 100 : 0,
      lastPrice: price,
      pair: `${message.data.coin}/USD`,
    };
  } catch {
    return undefined;
  }
}

function mergeTicker(current: TickerItem[], updates: TickerItem[]): TickerItem[] {
  const byPair = new Map(current.map((item) => [item.pair, item]));
  for (const update of updates) {
    byPair.set(update.pair, {
      ...byPair.get(update.pair),
      ...update,
    });
  }
  return sortTicker([...byPair.values()]);
}

function sortTicker(items: TickerItem[]): TickerItem[] {
  return [...items].sort((left, right) => {
    const leftOrder = PAIR_ORDER.get(left.pair) ?? 100;
    const rightOrder = PAIR_ORDER.get(right.pair) ?? 100;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.pair.localeCompare(right.pair);
  });
}

function coinsFromTicker(ticker: TickerItem[]): string[] {
  const coins = ticker
    .map((item) => item.pair.split("/")[0])
    .filter((coin): coin is string => Boolean(coin));
  return [...new Set(coins.length > 0 ? coins : DEFAULT_TICKER.map((item) => item.pair.split("/")[0]))];
}

function firstFinite(values: unknown[]): number {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}
