"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { emptyLiquidityAccount } from "@/lib/liquidity-account";
import { pnlxGet } from "@/lib/pnlx-api";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useWalletSession } from "@/lib/use-wallet-session";

interface TierBenefit {
  tier: "Standard" | "Silver" | "Gold" | "Platinum";
  threshold: number;
  feeRebatePercent: number;
  referralSharePercent: number;
  creditDropWeight: number;
}

interface PointsSnapshot {
  activePoints: number;
  benefits: TierBenefit;
  complete: boolean;
  lifetimePoints: number;
  nextTier: TierBenefit | null;
  tier: TierBenefit["tier"];
}

const tiers: TierBenefit[] = [
  { tier: "Standard", threshold: 0, feeRebatePercent: 0, referralSharePercent: 0, creditDropWeight: 1 },
  { tier: "Silver", threshold: 250, feeRebatePercent: 5, referralSharePercent: 5, creditDropWeight: 1.5 },
  { tier: "Gold", threshold: 1_000, feeRebatePercent: 10, referralSharePercent: 7.5, creditDropWeight: 2 },
  { tier: "Platinum", threshold: 3_000, feeRebatePercent: 15, referralSharePercent: 10, creditDropWeight: 3 },
];

export function PointsPage() {
  const wallet = useWalletSession();
  const ticker = useMarketTicker();
  const [loaded, setLoaded] = useState<{ address: string; points: PointsSnapshot } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    const session = wallet.session;
    if (!session) return;
    const load = () => {
      void pnlxGet<{ points: PointsSnapshot }>("/points", session.token)
        .then((response) => { if (active) { setLoaded({ address: session.address, points: response.points }); setError(null); } })
        .catch((cause) => { if (active) { setLoaded(null); setError(cause instanceof Error ? cause.message : "Points unavailable"); } })
        .finally(() => { if (active) setLoading(false); });
    };
    const start = window.setTimeout(() => { if (active) { setLoading(true); load(); } }, 0);
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearTimeout(start); window.clearInterval(timer); };
  }, [wallet.session]);

  const points = loaded && wallet.session?.address === loaded.address ? loaded.points : null;
  const next = points?.nextTier;
  return (
    <AppShell account={emptyLiquidityAccount} activeView="points" wallet={wallet}>
      <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-10 md:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">Points</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">Your activity, counted over the last 90 days.</p>

        {!wallet.session ? (
          <div className="mt-10 border-t border-[var(--line)] py-8 text-[var(--text-muted)]">Connect your wallet to view your points.</div>
        ) : error ? (
          <div className="mt-10 border-t border-[var(--line)] py-8 text-[var(--text-muted)]" role="alert">{error}</div>
        ) : !points ? (
          <div className="mt-10 border-t border-[var(--line)] py-8 text-[var(--text-muted)]">{loading ? "Loading points…" : "Points unavailable"}</div>
        ) : (
          <>
            <div className="mt-10 grid gap-6 border-y border-[var(--line)] py-7 sm:grid-cols-3">
              <div><span className="text-sm text-[var(--text-muted)]">Your tier</span><strong className="mt-2 block text-3xl font-semibold">{points.tier}</strong></div>
              <div><span className="text-sm text-[var(--text-muted)]">90-day points</span><strong className="mt-2 block text-3xl font-semibold">{points.activePoints.toLocaleString()}</strong></div>
              <div><span className="text-sm text-[var(--text-muted)]">Lifetime points</span><strong className="mt-2 block text-3xl font-semibold">{points.lifetimePoints.toLocaleString()}</strong></div>
            </div>
            {!points.complete ? <p className="mt-4 text-sm text-[var(--accent-orange)]">Some settled activity is still being reconciled.</p> :
              next ? <p className="mt-4 text-sm text-[var(--text-muted)]">{(next.threshold - points.activePoints).toLocaleString()} points to {next.tier}</p> : null}
          </>
        )}

        <section className="mt-14" aria-label="Points tiers">
          <h2 className="text-xl font-semibold">Tier benefits</h2>
          <div className="mt-5 overflow-x-auto border-t border-[var(--line)]">
            <table className="w-full min-w-[620px] border-collapse text-left text-sm">
              <thead className="text-[var(--text-faint)]"><tr className="border-b border-[var(--line)]">
                <th className="py-4 pr-4 font-medium">Tier</th><th className="py-4 pr-4 font-medium">90-day points</th>
                <th className="py-4 pr-4 font-medium">Fee rebate</th><th className="py-4 pr-4 font-medium">Referral share</th>
                <th className="py-4 font-medium">Credit Drop weight</th>
              </tr></thead>
              <tbody>{tiers.map((tier) => <tr className="border-b border-[var(--line)]" key={tier.tier}>
                <td className={`py-4 pr-4 font-medium ${points?.tier === tier.tier ? "text-[var(--accent-orange)]" : ""}`}>{tier.tier}</td>
                <td className="py-4 pr-4">{tier.threshold.toLocaleString()}</td>
                <td className="py-4 pr-4">{tier.feeRebatePercent}%</td>
                <td className="py-4 pr-4">{tier.referralSharePercent}%</td>
                <td className="py-4">{tier.creditDropWeight}×</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>
      </main>
      <BottomTicker ticker={ticker.ticker} updatedAt={ticker.updatedAt} />
    </AppShell>
  );
}
