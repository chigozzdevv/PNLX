"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { pnlxGet } from "@/lib/pnlx-api";
import { useWalletSession } from "@/lib/use-wallet-session";

export interface TierBenefit {
  tier: "Standard" | "Silver" | "Gold" | "Platinum";
  threshold: number;
  feeRebatePercent: number;
  referralSharePercent: number;
  creditDropWeight: number;
}

export interface PointsSnapshot {
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

const PARTIAL_POINTS_DESCRIPTION = "Verified points. Some of your trades could not be included.";

export function PointsPage() {
  const wallet = useWalletSession();
  const [loaded, setLoaded] = useState<{ address: string; points: PointsSnapshot } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    const session = wallet.session;
    if (!session) return;
    const load = () => {
      void pnlxGet<{ points: PointsSnapshot }>("/points", session.token)
        .then((response) => { if (active) { setLoaded({ address: session.address, points: response.points }); setError(null); } })
        .catch((cause) => { if (active) { setLoaded(null); setError(cause instanceof Error ? cause.message : "Unable to retrieve points"); } });
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refreshKey, wallet.session]);

  const points = loaded && wallet.session?.address === loaded.address ? loaded.points : null;
  return (
    <AppShell activeView="points" wallet={wallet}>
      <main className="account-page points-page">
        <div className="account-page-heading"><h1>Points</h1></div>

        {!wallet.session ? (
          <div className="page-empty-state">Connect your wallet to view your points.</div>
        ) : error ? (
          <div className="page-empty-state" role="alert">
            <span>{error}</span>
            <button className="page-action-secondary" type="button" onClick={() => { setError(null); setRefreshKey((key) => key + 1); }}>Retry</button>
          </div>
        ) : !points ? (
          <div aria-label="Loading points" className="page-empty-state" role="status">
            <span aria-hidden="true" className="points-loading-dots"><span /><span /><span /></span>
          </div>
        ) : (
          <PointsOverview points={points} />
        )}

        <PointsTierBenefits points={points} />
      </main>
    </AppShell>
  );
}

export function PointsOverview({ points }: { points: PointsSnapshot }) {
  const next = points.nextTier;
  const partial = !points.complete;
  const progress = next
    ? Math.max(0, Math.min(100, (points.activePoints - points.benefits.threshold) / (next.threshold - points.benefits.threshold) * 100))
    : 0;
  return (
    <>
      <div aria-label="Points overview" className="account-stats points-stats">
        <div className="account-stat points-stat-active">
          <span>90-day points</span>
          <strong className={partial ? "points-value-partial" : undefined} title={partial ? PARTIAL_POINTS_DESCRIPTION : undefined}>
            {points.activePoints.toLocaleString()}
            {partial ? <span className="sr-only">. {PARTIAL_POINTS_DESCRIPTION}</span> : null}
          </strong>
        </div>
        <div className="account-stat points-stat-tier">
          <span>Tier</span>
          <strong className={partial ? "points-value-partial" : undefined} title={partial ? PARTIAL_POINTS_DESCRIPTION : undefined}>
            {points.tier}
            {partial ? <span className="sr-only">. {PARTIAL_POINTS_DESCRIPTION}</span> : null}
          </strong>
        </div>
        <div className="account-stat">
          <span>Lifetime points</span>
          <strong className={partial ? "points-value-partial" : undefined} title={partial ? PARTIAL_POINTS_DESCRIPTION : undefined}>
            {points.lifetimePoints.toLocaleString()}
            {partial ? <span className="sr-only">. {PARTIAL_POINTS_DESCRIPTION}</span> : null}
          </strong>
        </div>
      </div>
      {points.complete && next ? (
        <div className="points-tier-progress">
          <div className="points-progress-labels"><span>{next.tier}</span><span>{points.activePoints.toLocaleString()} / {next.threshold.toLocaleString()}</span></div>
          <div
            aria-label={`Progress to ${next.tier}`}
            aria-valuemax={next.threshold}
            aria-valuemin={points.benefits.threshold}
            aria-valuenow={points.activePoints}
            className="points-progress-track"
            role="progressbar"
          ><span style={{ width: `${progress}%` }} /></div>
        </div>
      ) : null}
    </>
  );
}

export function PointsTierBenefits({ points }: { points: PointsSnapshot | null }) {
  const partial = points !== null && !points.complete;
  return (
    <section className="page-section" aria-label="Points tiers">
      <div className="page-section-heading"><h2>Tier benefits</h2></div>
      <div className="points-tier-table-wrap">
        <table className="points-tier-table">
          <thead><tr>
            <th scope="col">Tier</th><th scope="col" title="Minimum points over the last 90 days">90-day points</th>
            <th scope="col">Fee rebate</th><th scope="col">Referral share</th>
            <th scope="col">Credit Drop weight</th>
          </tr></thead>
          <tbody>{tiers.map((tier) => <tr data-current={points?.tier === tier.tier || undefined} key={tier.tier}>
            <th className={`points-tier-name${partial && points?.tier === tier.tier ? " points-value-partial" : ""}`} scope="row" title={partial && points?.tier === tier.tier ? PARTIAL_POINTS_DESCRIPTION : undefined}>{tier.tier}</th>
            <td><span className="points-tier-mobile-label">90-day points</span>{tier.threshold.toLocaleString()}</td>
            <td><span className="points-tier-mobile-label">Fee rebate</span>{tier.feeRebatePercent}%</td>
            <td><span className="points-tier-mobile-label">Referral share</span>{tier.referralSharePercent}%</td>
            <td><span className="points-tier-mobile-label">Credit Drop weight</span>{tier.creditDropWeight}×</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}
