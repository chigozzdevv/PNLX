"use client";

import { ExternalLink, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { emptyLiquidityAccount } from "@/lib/liquidity-account";
import {
  formatVaultUnits,
  parseVaultUnits,
  quoteVaultAction,
  submitVaultAction,
  type VaultAccount,
  type VaultStatus,
} from "@/lib/liquidity-vault";
import { useLiquidityVault } from "@/lib/use-liquidity-vault";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useWalletSession } from "@/lib/use-wallet-session";
import type { WalletSession } from "@/lib/wallet-auth";

type DialogMode = "deposit" | "withdraw";

export function LiquidityPoolDetails() {
  const wallet = useWalletSession();
  const vault = useLiquidityVault(wallet.session);
  const ticker = useMarketTicker([]);
  const searchParams = useSearchParams();
  const requestedAction = searchParams.get("action");
  const queryDialog: DialogMode | null = requestedAction === "supply" ? "deposit" : requestedAction === "withdraw" ? "withdraw" : null;
  const [dismissedAction, setDismissedAction] = useState<string | null>(null);
  const [manualDialog, setManualDialog] = useState<DialogMode | null>(null);
  const dialog = manualDialog ?? (dismissedAction === requestedAction ? null : queryDialog);
  const status = vault.status;
  const account = vault.account;
  const supplySharePrice = status && BigInt(status.depositSeriesShares) > 0n
    ? BigInt(status.depositSeriesAssets) * 10_000_000n / BigInt(status.depositSeriesShares)
    : status ? 10_000_000n : null;

  function closeDialog() {
    setManualDialog(null);
    setDismissedAction(requestedAction);
  }

  return (
    <AppShell account={emptyLiquidityAccount} activeView="liquidity" wallet={wallet}>
      <main className="liquidity-page">
        <div className="liquidity-heading">
          <Link className="liquidity-back-link" href="/liquidity">← Liquidity</Link>
          <h1>XLM/USD</h1>
          <p>USDC vault · Operated by PNLX</p>
        </div>

        <section aria-label="Your liquidity" className="liquidity-overview">
          <div className="liquidity-account-row">
            <div>
              <span className="portfolio-overview-label">Your liquidity</span>
              {!wallet.session ? (
                <p className="liquidity-wallet-hint">Connect wallet to view your position</p>
              ) : vault.loading ? (
                <p className="liquidity-wallet-hint">Loading your position…</p>
              ) : vault.accountError ? (
                <p className="liquidity-wallet-hint" role="alert">{vault.accountError}</p>
              ) : account?.equity !== null && account?.equity !== undefined ? (
                <strong className="liquidity-account-value">${formatVaultUnits(account.equity)}</strong>
              ) : (
                <p className="liquidity-wallet-hint">Value available after settlement</p>
              )}
            </div>
            <div className="liquidity-actions">
              <button className="portfolio-primary-action" onClick={() => setManualDialog("deposit")} type="button">Supply</button>
              <button className="liquidity-secondary-action" onClick={() => setManualDialog("withdraw")} type="button">Withdraw</button>
            </div>
          </div>

          <div className="liquidity-supporting-values">
            <div className="portfolio-supporting-value"><span>Pool APY</span><strong>—</strong></div>
            <div className="portfolio-supporting-value"><span>Total assets</span><strong>{status ? `$${formatVaultUnits(status.totalAssetsAtCost)}` : "—"}</strong></div>
            <div className="portfolio-supporting-value"><span>Your positions</span><strong>{account ? account.positions.length : "—"}</strong></div>
          </div>
          {vault.statusError ? <p className="liquidity-data-error" role="alert">{vault.statusError} <button onClick={vault.refresh} type="button">Retry</button></p> : null}
        </section>

        <section aria-label="Pool details" className="liquidity-performance">
          <div className="liquidity-section-heading"><h2>Pool details</h2></div>
          <div className="liquidity-detail-grid">
            <div><span>New supply price</span><strong>{supplySharePrice !== null ? `$${formatVaultUnits(supplySharePrice, 4)}` : "—"}</strong></div>
            <div><span>Liquid USDC</span><strong>{status ? `$${formatVaultUnits(status.liquidAssets)}` : "—"}</strong></div>
            <div><span>Deployed principal</span><strong>{status ? `$${formatVaultUnits(status.deployedPrincipal)}` : "—"}</strong></div>
            <div><span>Supply</span><strong>{status ? status.paused ? "Paused" : "Open" : "—"}</strong></div>
          </div>
          {status ? <p className="liquidity-pool-note">{status.paused ? "Deposits are currently paused." : "Deposits are open."} You can withdraw a position whenever it has no active maker allocation.</p> : null}
        </section>

        <section aria-label="Recent liquidity activity" className="liquidity-activity">
          <div className="liquidity-section-heading liquidity-activity-heading"><h2>Recent activity</h2></div>
          <p className="liquidity-activity-empty">Activity history isn’t available yet.</p>
        </section>
      </main>
      <BottomTicker ticker={ticker.ticker} updatedAt={ticker.updatedAt} />
      {dialog ? (
        <LiquidityActionDialog
          account={account}
          accountError={vault.accountError}
          error={wallet.error}
          mode={dialog}
          onClose={closeDialog}
          onComplete={vault.refresh}
          onConnect={wallet.connect}
          session={wallet.session}
          status={status}
          statusError={vault.statusError}
        />
      ) : null}
    </AppShell>
  );
}

function LiquidityActionDialog({ account, accountError, error, mode, onClose, onComplete, onConnect, session, status, statusError }: {
  account: VaultAccount | null;
  accountError: string | null;
  error?: string;
  mode: DialogMode;
  onClose: () => void;
  onComplete: () => void;
  onConnect: () => Promise<void>;
  session: WalletSession | null;
  status: VaultStatus | null;
  statusError: string | null;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [transactionHash, setTransactionHash] = useState<string | null>(null);
  const [requestedSeries, setRequestedSeries] = useState<number | null>(null);
  const deposit = mode === "deposit";
  const withdrawablePositions = account?.positions.filter((position) => position.withdrawalsOpen && BigInt(position.availableShares) > 0n) ?? [];
  const selectedPosition = withdrawablePositions.find((position) => position.series === requestedSeries) ?? withdrawablePositions[0];
  const unavailable = statusError || (!status ? "Loading pool…" : deposit
    ? status.paused ? "Deposits are currently paused." : null
    : accountError || (withdrawablePositions.length === 0 ? "No settled position is ready to withdraw." : null));
  let quote: ReturnType<typeof quoteVaultAction> | null = null;
  let quoteError: string | null = null;
  if (status && amount.trim()) {
    try {
      quote = quoteVaultAction(mode, parseVaultUnits(amount), status, account, selectedPosition?.series);
    } catch (caught) {
      quoteError = caught instanceof Error ? caught.message : "Invalid amount";
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit() {
    if (!session || !quote || busy) return;
    setBusy(true);
    setActionError(null);
    setTransactionHash(null);
    try {
      const hash = await submitVaultAction(session, quote.action);
      setTransactionHash(hash);
      setAmount("");
      onComplete();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Vault transaction failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="liquidity-dialog-backdrop" onClick={onClose} role="presentation">
      <section aria-label={deposit ? "Supply liquidity" : "Withdraw liquidity"} aria-modal="true" className="liquidity-dialog" onClick={(event) => event.stopPropagation()} role="dialog">
        <div className="liquidity-dialog-header">
          <div><span>XLM/USD · USDC</span><h2>{deposit ? "Supply liquidity" : "Withdraw"}</h2></div>
          <button aria-label="Close" onClick={onClose} type="button"><X aria-hidden="true" size={18} /></button>
        </div>
        {!session ? (
          <>
            <p className="liquidity-dialog-connect-copy">Connect your wallet to {deposit ? "supply USDC" : "view and withdraw your shares"}.</p>
            {error ? <p className="liquidity-dialog-error" role="alert">{error}</p> : null}
            <button className="portfolio-primary-action liquidity-dialog-done" onClick={() => void onConnect()} type="button">Connect wallet</button>
          </>
        ) : (
          <>
            {unavailable ? <p className="liquidity-dialog-note" role="status">{unavailable}</p> : null}
            {!deposit && withdrawablePositions.length > 1 ? (
              <>
                <label className="liquidity-dialog-input-label" htmlFor="liquidity-series">Position</label>
                <select className="liquidity-series-select" id="liquidity-series" onChange={(event) => { setRequestedSeries(Number(event.target.value)); setAmount(""); }} value={selectedPosition?.series}>
                  {withdrawablePositions.map((position) => <option key={position.series} value={position.series}>Position {position.series + 1} · {formatVaultUnits(position.availableShares, 4)} shares</option>)}
                </select>
              </>
            ) : null}
            <label className="liquidity-dialog-input-label" htmlFor="liquidity-amount">{deposit ? "Amount" : "Shares"}</label>
            <div className="liquidity-dialog-input-wrap">
              <input disabled={Boolean(unavailable) || busy} id="liquidity-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); setTransactionHash(null); }} placeholder="0.00" type="text" value={amount} />
              <span>{deposit ? "USDC" : "SHARES"}</span>
            </div>
            {quote ? (
              <>
                <div className="liquidity-dialog-detail"><span>Estimated {deposit ? "shares" : "USDC"}</span><strong>{formatVaultUnits(quote.estimated, 4)}</strong></div>
                <div className="liquidity-dialog-detail"><span>Minimum received</span><strong>{formatVaultUnits(quote.minimum, 4)}</strong></div>
              </>
            ) : null}
            {!deposit && selectedPosition ? <div className="liquidity-dialog-detail"><span>Available shares</span><strong>{formatVaultUnits(selectedPosition.availableShares, 4)}</strong></div> : null}
            {quoteError && !unavailable ? <p className="liquidity-dialog-error" role="alert">{quoteError}</p> : null}
            {actionError ? <p className="liquidity-dialog-error" role="alert">{actionError}</p> : null}
            {transactionHash ? (
              <p className="liquidity-dialog-success" role="status">
                Transaction submitted · <a href={`https://stellar.expert/explorer/testnet/tx/${transactionHash.replace(/^0x/, "")}`} rel="noopener noreferrer" target="_blank">View on explorer <ExternalLink aria-hidden="true" size={12} /></a>
              </p>
            ) : null}
            <button className="portfolio-primary-action liquidity-dialog-done" disabled={!quote || Boolean(unavailable) || busy} onClick={() => void submit()} type="button">
              {busy ? "Confirming…" : deposit ? "Supply USDC" : "Withdraw USDC"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
