"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { emptyLiquidityAccount } from "@/lib/liquidity-account";
import { formatVaultUnits } from "@/lib/liquidity-vault";
import { useLiquidityVault } from "@/lib/use-liquidity-vault";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useWalletSession } from "@/lib/use-wallet-session";

const detailsHref = "/liquidity/xlm-usd";

export function LiquidityPoolsPage() {
  const wallet = useWalletSession();
  const ticker = useMarketTicker([]);
  const vault = useLiquidityVault(wallet.session);
  const connected = Boolean(wallet.session);
  const status = vault.status;

  return (
    <AppShell account={emptyLiquidityAccount} activeView="liquidity" wallet={wallet}>
      <main className="liquidity-page liquidity-list-page">
        <div className="liquidity-heading">
          <h1>Liquidity</h1>
          <p>Provide USDC liquidity for PNLX trades.</p>
        </div>

        <section aria-label="Liquidity pools" className="liquidity-pools">
          <div aria-hidden="true" className="liquidity-pool-head">
            <div className="liquidity-pool-head-main">
              <span>Pool</span>
              <span>Kind</span>
              <span>Operator</span>
              <span>APY</span>
              <span>Total assets</span>
              <span>Your shares</span>
            </div>
            <span>Actions</span>
          </div>
          {status ? (
            <div className="liquidity-pool-row">
              <Link aria-label="View XLM/USD pool details" className="liquidity-pool-main" href={detailsHref}>
                <span className="liquidity-pool-name"><strong>XLM/USD</strong><small>USDC liquidity <ArrowUpRight aria-hidden="true" size={12} /></small></span>
                <span className="liquidity-pool-cell"><small>Kind</small><strong>Vault</strong></span>
                <span className="liquidity-pool-cell" title={status.operator}><small>Operator</small><strong>PNLX</strong></span>
                <span className="liquidity-pool-cell"><small>APY</small><strong className="liquidity-pool-muted">—</strong></span>
                <span className="liquidity-pool-cell"><small>Total assets</small><strong>${formatVaultUnits(status.totalAssetsAtCost)}</strong></span>
                <span className="liquidity-pool-cell">
                  <small>Your shares</small>
                  <strong className={vault.account ? "" : "liquidity-pool-muted"}>
                    {!connected ? "Connect to view" : vault.loading ? "Loading…" : vault.account ? formatVaultUnits(vault.account.shares) : "Unavailable"}
                  </strong>
                </span>
              </Link>
              <div className="liquidity-pool-actions">
                <Link className="liquidity-pool-supply" href={`${detailsHref}?action=supply`}>Supply</Link>
                <Link className="liquidity-pool-withdraw" href={`${detailsHref}?action=withdraw`}>Withdraw</Link>
              </div>
            </div>
          ) : (
            <div className="liquidity-pool-state" role={vault.statusError ? "alert" : "status"}>
              <span>{vault.statusError ?? "Loading pool…"}</span>
              {vault.statusError ? <button onClick={vault.refresh} type="button">Retry</button> : null}
            </div>
          )}
        </section>
      </main>
      <BottomTicker ticker={ticker.ticker} updatedAt={ticker.updatedAt} />
    </AppShell>
  );
}
