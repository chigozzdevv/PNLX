"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { VaultApy } from "@/components/vault-apy";
import { shortAddress } from "@/lib/format";
import { formatVaultUnits } from "@/lib/liquidity-vault";
import { useLiquidityVault } from "@/lib/use-liquidity-vault";
import { useWalletSession } from "@/lib/use-wallet-session";

const detailsHref = "/liquidity/xlm-usd";

export function LiquidityPoolsPage() {
  const wallet = useWalletSession();
  const vault = useLiquidityVault(wallet.session);
  const connected = Boolean(wallet.session);
  const status = vault.status;

  return (
    <AppShell activeView="liquidity" wallet={wallet}>
      <main className="account-page liquidity-page liquidity-list-page">
        <div className="account-page-heading liquidity-heading">
          <div>
            <h1>Liquidity</h1>
            <p>Provide USDC liquidity for PNLX trades.</p>
          </div>
        </div>

        <section aria-label="Liquidity pools" className="liquidity-pools">
          <div aria-hidden="true" className="liquidity-pool-head">
            <div className="liquidity-pool-head-main">
              <span>Pool</span>
              <span>Operator</span>
              <span>Est. APY</span>
              <span>Assets at cost</span>
              <span>Your positions</span>
            </div>
            <span>Actions</span>
          </div>
          {status ? (
            <div className="liquidity-pool-row">
              <div className="liquidity-pool-main">
                <Link aria-label="View XLM/USD pool details" className="liquidity-pool-name" href={detailsHref}><strong>XLM/USD</strong><small>USDC liquidity <ArrowUpRight aria-hidden="true" size={12} /></small></Link>
                <span className="liquidity-pool-cell liquidity-pool-operator">
                  <small>Operator</small>
                  <strong>PNLX <span>(<a
                    aria-label={`View maker ${status.maker} on Stellar Expert`}
                    className="liquidity-operator-address"
                    href={`https://stellar.expert/explorer/testnet/account/${encodeURIComponent(status.maker)}`}
                    rel="noopener noreferrer"
                    target="_blank"
                    title={status.maker}
                  >{shortAddress(status.maker)}</a>)</span></strong>
                </span>
                <span className="liquidity-pool-cell"><small>Est. APY</small><VaultApy history={vault.history} /></span>
                <span className="liquidity-pool-cell"><small>Assets at cost</small><strong>${formatVaultUnits(status.totalAssetsAtCost)}</strong></span>
                <span className="liquidity-pool-cell">
                  <small>Your positions</small>
                  <strong className={vault.account ? "" : "liquidity-pool-muted"}
                    title={!connected ? "Connect wallet to view your positions" : vault.loading ? "Loading your positions" : vault.accountError ?? undefined}>
                    {connected && !vault.loading && vault.account ? vault.account.positions.length : "—"}
                  </strong>
                </span>
              </div>
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
    </AppShell>
  );
}
