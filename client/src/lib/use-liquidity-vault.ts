"use client";

import { useCallback, useEffect, useState } from "react";
import { getVaultAccount, getVaultHistory, getVaultStatus, type VaultAccount, type VaultStatus, type VaultHistory } from "@/lib/liquidity-vault";
import type { WalletSession } from "@/lib/wallet-auth";

export function useLiquidityVault(session: WalletSession | null) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [account, setAccount] = useState<VaultAccount | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [history, setHistory] = useState<VaultHistory | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    let historyRequest: AbortController | undefined;
    const currentSession = session;
    const loadStatus = async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const pool = await getVaultStatus();
          if (active) { setStatus(pool); setStatusError(null); }
          return;
        } catch (error) {
          if (!active) return;
          if (attempt === 0) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
            if (!active) return;
            continue;
          }
          setStatus(null);
          setStatusError(error instanceof Error ? error.message : "Pool data is unavailable");
        }
      }
    };
    const load = () => {
      void loadStatus();
      if (currentSession) {
        void getVaultAccount(currentSession).then((position) => {
          if (active) { setAccount(position); setAccountError(null); }
        }).catch((error) => {
          if (active) {
            setAccount(null);
            setAccountError(error instanceof Error ? error.message : "Wallet position is unavailable");
          }
        }).finally(() => {
          if (active) setLoading(false);
        });
      }
    };
    const loadHistory = async () => {
      if (historyRequest) return;
      const request = new AbortController();
      historyRequest = request;
      const timeout = window.setTimeout(() => request.abort(), 20_000);
      try {
        const value = await getVaultHistory(request.signal);
        if (active && !request.signal.aborted) { setHistory(value); setHistoryError(false); }
      } catch {
        if (active) {
          setHistoryError(true);
          setHistory((previous) => previous ? { ...previous, stale: true,
            performance: previous.performance ? { ...previous.performance, status: "stale" } : undefined } : null);
        }
      } finally {
        window.clearTimeout(timeout);
        if (historyRequest === request) historyRequest = undefined;
      }
    };
    void Promise.resolve().then(() => {
      if (!active) return;
      setLoading(Boolean(currentSession));
      setStatusError(null);
      setAccountError(null);
      setAccount(null);
      load();
      void loadHistory();
    });
    const timer = window.setInterval(load, 60_000);
    const historyTimer = window.setInterval(() => void loadHistory(), 30_000);
    return () => { active = false; historyRequest?.abort(); window.clearInterval(timer); window.clearInterval(historyTimer); };
  }, [session, refreshKey]);

  return { account, accountError, history, historyError, loading, refresh, status, statusError };
}
