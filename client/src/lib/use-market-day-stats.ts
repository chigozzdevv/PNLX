"use client";

import { useEffect, useState } from "react";
import { parseMarketDayStats, refreshMarketDayStatsAge } from "@/lib/market-day-stats";
import { pnlxGet } from "@/lib/pnlx-api";
import type { MarketDayStats } from "@/types/trading";

export function useMarketDayStats(marketId?: string): MarketDayStats | undefined {
  const [snapshot, setSnapshot] = useState<MarketDayStats>();

  useEffect(() => {
    if (!marketId) return;
    let active = true;
    let pending: AbortController | undefined;
    const refresh = async () => {
      if (active) setSnapshot((previous) => previous?.marketId === marketId ? refreshMarketDayStatsAge(previous) : undefined);
      if (pending) return;
      const request = new AbortController();
      pending = request;
      const timeout = window.setTimeout(() => request.abort(), 10_000);
      try {
        const payload = await pnlxGet<unknown>(`/markets/stats?marketId=${encodeURIComponent(marketId)}`, undefined, request.signal);
        const stats = parseMarketDayStats(payload, marketId);
        if (active && !request.signal.aborted) setSnapshot(stats);
      } catch {
        if (active) setSnapshot((previous) => previous?.marketId === marketId ? refreshMarketDayStatsAge(previous) : undefined);
      } finally {
        window.clearTimeout(timeout);
        if (pending === request) pending = undefined;
      }
    };
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      pending?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [marketId]);

  return snapshot?.marketId === marketId ? snapshot : undefined;
}
