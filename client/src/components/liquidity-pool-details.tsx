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
  formatVaultSharePrice,
  getVaultHistory,
  parseVaultUnits,
  quoteVaultAction,
  quoteVaultWithdrawalClaim,
  quoteVaultWithdrawalRequest,
  selectVaultAssetPoints,
  submitVaultAction,
  vaultSharePrice,
  type VaultAccount,
  type VaultStatus,
  type VaultHistory,
  type VaultChartRange,
} from "@/lib/liquidity-vault";
import { useLiquidityVault } from "@/lib/use-liquidity-vault";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useWalletSession } from "@/lib/use-wallet-session";
import type { WalletSession } from "@/lib/wallet-auth";

type DialogMode = "deposit" | "withdraw";

function activityLabel(kind: VaultHistory["activity"][number]["kind"]): string {
  return { supply: "Added liquidity", allocation: "Allocated to maker",
    return: "Returned to pool", withdrawal: "Withdrew liquidity" }[kind];
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function PoolAssetsChart({ points }: { points: VaultHistory["assets"] }) {
  const values = points.map((point) => BigInt(point.assets));
  const times = points.map((point) => Date.parse(point.at));
  const firstTime = times[0] ?? 0;
  const timeSpan = (times.at(-1) ?? firstTime) - firstTime;
  const high = values.length ? values.reduce((max, value) => value > max ? value : max) : 0n;
  const coords = values.map((value, index) => ({
    x: values.length === 1 ? 50 : 1 + (timeSpan > 0 ? (times[index] - firstTime) * 98 / timeSpan : index * 98 / (values.length - 1)),
    y: high === 0n ? 88 : 88 - Number(value * 76_000n / high) / 1_000,
  }));
  const path = coords.map((point, index) => index === 0 ? `M ${point.x} ${point.y}` :
    `H ${point.x} V ${point.y}`).join(" ");

  return (
    <div className="liquidity-chart">
      {points.length ? (
        <>
          <svg aria-label="Total liquidity over time" className="liquidity-chart-plot" preserveAspectRatio="none" role="img" viewBox="0 0 100 100">
            <path className="liquidity-chart-guide" d="M 0 88 H 100" />
            {coords.length > 1 ? <path className="liquidity-chart-line" d={path} /> : null}
            <path className="liquidity-chart-point" d={`M ${coords.at(-1)!.x} ${coords.at(-1)!.y} h 0.001`} />
          </svg>
          <div className="liquidity-chart-dates"><span>{new Date(points[0].at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span><span>{points.length > 1 ? new Date(points.at(-1)!.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null}</span></div>
        </>
      ) : <div className="liquidity-chart-plot liquidity-chart-loading" />}
    </div>
  );
}

export function LiquidityPoolDetails() {
  const wallet = useWalletSession();
  const vault = useLiquidityVault(wallet.session);
  const ticker = useMarketTicker([]);
  const searchParams = useSearchParams();
  const requestedAction = searchParams.get("action");
  const queryDialog: DialogMode | null = requestedAction === "supply" ? "deposit" : requestedAction === "withdraw" ? "withdraw" : null;
  const [dismissedAction, setDismissedAction] = useState<string | null>(null);
  const [manualDialog, setManualDialog] = useState<DialogMode | null>(null);
  const [history, setHistory] = useState<VaultHistory | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [chartRange, setChartRange] = useState<VaultChartRange>("7D");
  const [chartNow, setChartNow] = useState(0);
  const dialog = manualDialog ?? (dismissedAction === requestedAction ? null : queryDialog);
  const status = vault.status;
  const account = vault.account;
  const recordedValue = account?.positions.reduce((sum, position) => sum + BigInt(position.assetsAtCost), 0n);
  const sharePrice = account && BigInt(account.shares) > 0n && recordedValue !== undefined
    ? vaultSharePrice(recordedValue, BigInt(account.shares))
    : status?.currentSeriesShares !== undefined
      ? vaultSharePrice(BigInt(status.currentSeriesAssets), BigInt(status.currentSeriesShares))
      : null;

  useEffect(() => {
    let active = true;
    const load = () => void getVaultHistory().then((result) => {
      if (active) { setHistory(result); setHistoryError(false); setChartNow(Date.now()); }
    }).catch(() => { if (active) setHistoryError(true); });
    load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [historyKey]);

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
              ) : account && recordedValue !== undefined ? (
                <>
                  <strong className="liquidity-account-value">${formatVaultUnits(account.equity ?? recordedValue)}{account.equity === null ? <sup>*</sup> : null}</strong>
                  <span className="liquidity-value-note">{formatVaultUnits(account.shares, 4)} shares{account.equity === null ? " · *Unsettled P&L excluded" : null}</span>
                </>
              ) : (
                <p className="liquidity-wallet-hint">—</p>
              )}
            </div>
            <div className="liquidity-actions">
              <button className="portfolio-primary-action" onClick={() => setManualDialog("deposit")} type="button">Supply</button>
              <button className="liquidity-secondary-action" onClick={() => setManualDialog("withdraw")} type="button">Withdraw</button>
            </div>
          </div>

          <div className="liquidity-supporting-values">
            <div className="portfolio-supporting-value"><span>Pool APY</span><strong aria-label="0 percent placeholder; APY is not calculated yet" className="liquidity-apy-placeholder" title="APY is not calculated yet">0%<sup>*</sup></strong></div>
            <div className="portfolio-supporting-value"><span>Assets at cost</span><strong>{status ? `$${formatVaultUnits(status.totalAssetsAtCost)}` : "—"}</strong></div>
          </div>
          {vault.statusError ? <p className="liquidity-data-error" role="alert">{vault.statusError} <button onClick={vault.refresh} type="button">Retry</button></p> : null}
        </section>

        <section aria-label="Total liquidity" className="liquidity-performance">
          <div className="liquidity-section-heading">
            <h2>Total liquidity</h2>
            <div aria-label="Chart range" className="liquidity-chart-ranges" role="group">
              {(["1D", "7D", "30D"] as const).map((range) => (
                <button aria-pressed={chartRange === range} className={chartRange === range ? "active" : ""} key={range}
                  onClick={() => setChartRange(range)} type="button">{range}</button>
              ))}
            </div>
          </div>
          <PoolAssetsChart points={selectVaultAssetPoints(history?.assets ?? [], chartRange,
            chartNow, history?.stale ? null : history?.observedAt)} />
          <div className="liquidity-detail-grid">
            <div><span>{account && BigInt(account.shares) > 0n ? "Your share price" : "Share price"}</span><strong>{sharePrice !== null ? <>${formatVaultSharePrice(sharePrice)}{account?.equity === null ? <sup>*</sup> : null}</> : "—"}</strong></div>
            <div><span>Liquid USDC</span><strong>{status ? `$${formatVaultUnits(status.liquidAssets)}` : "—"}</strong></div>
            <div><span>Deployed principal</span><strong>{status ? `$${formatVaultUnits(status.deployedPrincipal)}` : "—"}</strong></div>
          </div>
          {status?.paused ? <p className="liquidity-pool-note">Deposits paused.</p> : null}
        </section>

        <section aria-label="Recent liquidity activity" className="liquidity-activity">
          <div className="liquidity-section-heading liquidity-activity-heading"><h2>Recent activity</h2></div>
          {history?.activity.length ? (
            <div className="liquidity-activity-list">
              {history.activity.slice(0, 6).map((item) => (
                <div className="liquidity-activity-item" key={item.id}>
                  <div><strong>{activityLabel(item.kind)}</strong><span>{new Date(item.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span></div>
                  <div><strong>${formatVaultUnits(item.amount)}</strong><a href={`https://stellar.expert/explorer/testnet/tx/${item.txHash}`} rel="noopener noreferrer" target="_blank">{shortHash(item.txHash)} <ExternalLink aria-hidden="true" size={12} /></a></div>
                </div>
              ))}
            </div>
          ) : <p className="liquidity-activity-empty">{historyError || history?.stale ? "Activity unavailable." : history ? "No recent pool activity." : "Loading activity…"}</p>}
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
          onComplete={() => { vault.refresh(); setHistoryKey((current) => current + 1); }}
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
  const positions = account?.positions.filter((position) => BigInt(position.shares) > 0n) ?? [];
  const selectedPosition = positions.find((position) => position.series === requestedSeries) ?? positions[0];
  const withdrawalStep = selectedPosition && BigInt(selectedPosition.pendingShares) > 0n
    ? selectedPosition.withdrawalsOpen ? "claim" : "waiting"
    : selectedPosition?.withdrawalsOpen ? "withdraw" : "request";
  const unavailable = statusError || (!status ? "Loading pool…" : deposit
    ? status.paused ? "Deposits are currently paused." : null
    : accountError || (positions.length === 0 ? "No liquidity position to withdraw." :
      withdrawalStep === "waiting" ? "Withdrawal requested. Claim when funds return to the vault." : null));
  let quote: ReturnType<typeof quoteVaultAction> | null = null;
  let quoteError: string | null = null;
  if (status && !deposit && withdrawalStep === "claim" && selectedPosition) {
    try {
      quote = quoteVaultWithdrawalClaim(selectedPosition);
    } catch (caught) {
      quoteError = caught instanceof Error ? caught.message : "Withdrawal is unavailable";
    }
  } else if (status && amount.trim()) {
    try {
      const units = parseVaultUnits(amount);
      quote = !deposit && withdrawalStep === "request" && selectedPosition
        ? quoteVaultWithdrawalRequest(units, selectedPosition)
        : quoteVaultAction(mode, units, status, account, selectedPosition?.series);
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
            {!deposit && withdrawalStep === "request" && !unavailable ? (
              <p className="liquidity-dialog-note">Request now. Claim when funds return to the vault.</p>
            ) : null}
            {!deposit && positions.length > 1 ? (
              <>
                <label className="liquidity-dialog-input-label" htmlFor="liquidity-series">Position</label>
                <select className="liquidity-series-select" id="liquidity-series" onChange={(event) => { setRequestedSeries(Number(event.target.value)); setAmount(""); }} value={selectedPosition?.series}>
                  {positions.map((position) => <option key={position.series} value={position.series}>Position {position.series + 1} · {formatVaultUnits(position.shares, 4)} shares</option>)}
                </select>
              </>
            ) : null}
            {deposit || withdrawalStep === "withdraw" || withdrawalStep === "request" ? (
              <>
                <label className="liquidity-dialog-input-label" htmlFor="liquidity-amount">{deposit ? "Amount" : "Shares"}</label>
                <div className="liquidity-dialog-input-wrap">
                  <input disabled={Boolean(unavailable) || busy} id="liquidity-amount" inputMode="decimal" onChange={(event) => { setAmount(event.target.value); setTransactionHash(null); }} placeholder="0.00" type="text" value={amount} />
                  <span>{deposit ? "USDC" : "SHARES"}</span>
                </div>
              </>
            ) : null}
            {quote && withdrawalStep !== "request" ? (
              <>
                <div className="liquidity-dialog-detail"><span>Estimated {deposit ? "shares" : "USDC"}</span><strong>{formatVaultUnits(quote.estimated, 4)}</strong></div>
                <div className="liquidity-dialog-detail"><span>Minimum received</span><strong>{formatVaultUnits(quote.minimum, 4)}</strong></div>
              </>
            ) : null}
            {!deposit && selectedPosition ? <div className="liquidity-dialog-detail"><span>{withdrawalStep === "claim" || withdrawalStep === "waiting" ? "Requested shares" : "Requestable shares"}</span><strong>{formatVaultUnits(withdrawalStep === "claim" || withdrawalStep === "waiting" ? selectedPosition.pendingShares : selectedPosition.availableShares, 4)}</strong></div> : null}
            {quoteError && !unavailable ? <p className="liquidity-dialog-error" role="alert">{quoteError}</p> : null}
            {actionError ? <p className="liquidity-dialog-error" role="alert">{actionError}</p> : null}
            {transactionHash ? (
              <p className="liquidity-dialog-success" role="status">
                Transaction submitted · <a href={`https://stellar.expert/explorer/testnet/tx/${transactionHash.replace(/^0x/, "")}`} rel="noopener noreferrer" target="_blank">View on explorer <ExternalLink aria-hidden="true" size={12} /></a>
              </p>
            ) : null}
            <button className="portfolio-primary-action liquidity-dialog-done" disabled={!quote || Boolean(unavailable) || busy} onClick={() => void submit()} type="button">
              {busy ? "Confirming…" : deposit ? "Supply USDC" : withdrawalStep === "request" ? "Request withdrawal" : withdrawalStep === "claim" ? "Claim USDC" : "Withdraw USDC"}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
