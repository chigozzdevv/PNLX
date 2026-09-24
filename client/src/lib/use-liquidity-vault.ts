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
      await Promise.resolve();
      if (!active) return;
      setLoading(Boolean(currentSession));
      setStatusError(null);
      setAccountError(null);
      setAccount(null);
      void getVaultStatus().then((pool) => {
        if (active) setStatus(pool);
      }).catch((error) => {
        if (!active) return;
        setStatus(null);
        setStatusError(error instanceof Error ? error.message : "Pool data is unavailable");
      });
      if (currentSession) {
        void getVaultAccount(currentSession).then((position) => {
          if (active) setAccount(position);
        }).catch((error) => {
          if (active) setAccountError(error instanceof Error ? error.message : "Wallet position is unavailable");
        }).finally(() => {
          if (active) setLoading(false);
        });
      }
    };
    void load();
    return () => { active = false; };
  }, [session, refreshKey]);

  return { account, accountError, loading, refresh, status, statusError };
}
