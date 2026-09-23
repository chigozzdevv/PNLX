"use client";

import { useCallback, useEffect, useState } from "react";
import { getVaultAccount, getVaultStatus, type VaultAccount, type VaultStatus } from "@/lib/liquidity-vault";
import type { WalletSession } from "@/lib/wallet-auth";

export function useLiquidityVault(session: WalletSession | null) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [account, setAccount] = useState<VaultAccount | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    const currentSession = session;
    const load = async () => {
      setLoading(true);
      setStatusError(null);
      setAccountError(null);
      setAccount(null);
      const [poolResult, accountResult] = await Promise.allSettled([
        getVaultStatus(),
        currentSession ? getVaultAccount(currentSession) : Promise.resolve(null),
      ]);
      if (!active) return;
      if (poolResult.status === "fulfilled") setStatus(poolResult.value);
      else {
        setStatus(null);
        setStatusError(poolResult.reason instanceof Error ? poolResult.reason.message : "Pool data is unavailable");
      }
      if (accountResult.status === "fulfilled") setAccount(accountResult.value);
      else setAccountError(accountResult.reason instanceof Error ? accountResult.reason.message : "Wallet position is unavailable");
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [session, refreshKey]);

  return { account, accountError, loading, refresh, status, statusError };
}
