"use client";

import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { useWalletSession } from "@/lib/use-wallet-session";
import { claimReward, getRewards, type RewardKind, type RewardsAccount } from "@/lib/rewards";
import { formatVaultUnits } from "@/lib/liquidity-vault";
import { pnlxPost } from "@/lib/pnlx-api";

const rewardTypes = [
  { name: "Fee rebates", rowName: "Fee rebate", kind: "rebate" },
  { name: "Referral earnings", rowName: "Referral earnings", kind: "referral" },
] as const;

interface RewardsFailure {
  address: string;
  operation: "load" | "claim" | "copy";
  detail: string;
}

interface RewardClaim {
  address: string;
  generation: number;
  kind: RewardKind;
}

export function RewardsPage() {
  const wallet = useWalletSession();
  const [loaded, setLoaded] = useState<{ address: string; rewards: RewardsAccount } | null>(null);
  const [failure, setFailure] = useState<RewardsFailure | null>(null);
  const [claiming, setClaiming] = useState<RewardClaim | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [referralStatus, setReferralStatus] = useState<{ address: string; linked: boolean; detail?: string } | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const sessionGeneration = useRef(0);
  const readVersion = useRef(0);
  const activeClaim = useRef<RewardClaim | null>(null);

  useEffect(() => {
    const generation = ++sessionGeneration.current;
    const session = wallet.session;
    if (!session) return;
    let active = true;
    const load = () => {
      if (activeClaim.current?.generation === generation) return;
      const version = ++readVersion.current;
      const current = () => active && sessionGeneration.current === generation && readVersion.current === version;
      void getRewards(session).then((rewards) => {
        rewardRows(rewards);
        if (current()) { setLoaded({ address: session.address, rewards }); setFailure(null); }
      }).catch((cause) => {
        if (current()) setFailure({ address: session.address, operation: "load", detail: errorDetail(cause, "Rewards unavailable") });
      });
    };
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      active = false;
      if (sessionGeneration.current === generation) sessionGeneration.current += 1;
      window.clearInterval(timer);
    };
  }, [wallet.session, refreshKey]);

  useEffect(() => {
    const session = wallet.session;
    if (!session) return;
    const referrer = new URLSearchParams(window.location.search).get("ref");
    if (!referrer) return;
    let active = true;
    void pnlxPost<{ registeredAt: number }>("/rewards/referral", { referrer }, session.token)
      .then(() => { if (active) setReferralStatus({ address: session.address, linked: true }); })
      .catch((cause) => {
        if (active) setReferralStatus({ address: session.address, linked: false, detail: errorDetail(cause, "Referral unavailable") });
      });
    return () => { active = false; };
  }, [wallet.session]);

  const rewards = loaded?.address === wallet.session?.address ? loaded?.rewards ?? null : null;
  const currentFailure = failure?.address === wallet.session?.address ? failure : null;
  const currentReferral = referralStatus?.address === wallet.session?.address ? referralStatus : null;

  async function onClaim(kind: RewardKind) {
    const session = wallet.session;
    const generation = sessionGeneration.current;
    if (!session || !rewards?.contractId || activeClaim.current?.generation === generation ||
      !rewards[kind] || rewardUnits(rewards[kind].claimable) <= 0n) return;
    const claim = { address: session.address, generation, kind };
    const current = () => sessionGeneration.current === generation;
    activeClaim.current = claim;
    readVersion.current += 1;
    setClaiming(claim);
    setFailure(null);
    let confirmed = false;
    try {
      await claimReward(session, kind, rewards.contractId);
      confirmed = true;
      if (!current()) return;
      const next = await getRewards(session);
      rewardRows(next);
      if (current()) setLoaded({ address: session.address, rewards: next });
    } catch (cause) {
      if (!current()) return;
      const detail = errorDetail(cause, "Reward claim failed");
      if (confirmed) setLoaded((current) => current?.address === session.address ? null : current);
      setFailure({ address: session.address, operation: confirmed ? "load" : "claim",
        detail: confirmed ? `Claim confirmed. Balance refresh failed: ${detail}` : detail });
    } finally {
      if (activeClaim.current === claim) activeClaim.current = null;
      setClaiming((currentClaim) => currentClaim === claim ? null : currentClaim);
    }
  }

  async function copyReferralLink() {
    const session = wallet.session;
    if (!session) return;
    const generation = sessionGeneration.current;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/rewards?ref=${session.address}`);
      if (sessionGeneration.current !== generation) return;
      setCopiedAddress(session.address);
      setFailure((current) => current?.address === session.address && current.operation === "copy" ? null : current);
      window.setTimeout(() => setCopiedAddress((current) => current === session.address ? null : current), 2_000);
    } catch (cause) {
      if (sessionGeneration.current !== generation) return;
      setFailure({ address: session.address, operation: "copy", detail: errorDetail(cause, "Referral link could not be copied") });
    }
  }

  return (
    <AppShell activeView="rewards" wallet={wallet}>
      <RewardsContent
        claiming={claiming && claiming.address === wallet.session?.address ? claiming.kind : null}
        connected={Boolean(wallet.session)}
        copied={Boolean(wallet.session && copiedAddress === wallet.session.address)}
        failure={currentFailure}
        loading={Boolean(wallet.session && !rewards && currentFailure?.operation !== "load")}
        onClaim={(kind) => void onClaim(kind)}
        onCopy={() => void copyReferralLink()}
        onRetry={() => { setFailure(null); setRefreshKey((value) => value + 1); }}
        referralStatus={currentReferral}
        rewards={rewards}
      />
    </AppShell>
  );
}

interface RewardsContentProps {
  claiming: RewardKind | null;
  connected: boolean;
  copied: boolean;
  failure: RewardsFailure | null;
  loading: boolean;
  onClaim: (kind: RewardKind) => void;
  onCopy: () => void;
  onRetry: () => void;
  referralStatus: { linked: boolean; detail?: string } | null;
  rewards: RewardsAccount | null;
}

export function RewardsContent({ claiming, connected, copied, failure, loading, onClaim, onCopy,
  onRetry, referralStatus, rewards }: RewardsContentProps) {
  const rows = rewards ? rewardRows(rewards).filter((row) => (row.claimable !== null && row.claimable > 0n) || row.pending > 0n) : [];
  const balancesPublished = Boolean(rewards?.rebate && rewards.referral);
  const failureLabel = failure?.operation === "claim" ? "Claim failed"
    : failure?.operation === "copy" ? "Link not copied" : "Rewards unavailable";

  return (
    <main className="account-page rewards-page">
      <div className="account-page-heading">
        <h1>Rewards</h1>
        {connected ? <button className="page-action-secondary" onClick={onCopy} type="button">
          {copied ? "Copied" : "Copy referral link"}
        </button> : null}
      </div>

      <section aria-label="Claimable reward balances" className="account-stats rewards-stats">
        {rewardTypes.map(({ name, kind }) => (
          <div className="account-stat" key={kind}>
            <span>{name}</span>
            <strong title={failure?.operation === "load" ? `Last loaded balance. ${failure.detail}` : `Claimable ${name.toLowerCase()}`}>
              {rewards?.[kind] ? rewardAmount(rewards[kind].claimable) : loading ? "…" : "—"}
            </strong>
          </div>
        ))}
      </section>

      {referralStatus ? <div className="rewards-notice" role="status" title={referralStatus.detail}>
        {referralStatus.linked ? "Referral linked" : "Referral unavailable"}
      </div> : null}

      <section aria-labelledby="rewards-claims-title" className="page-section rewards-claims">
        <div className="page-section-heading"><h2 id="rewards-claims-title">Claims</h2></div>
        {failure ? <div className="rewards-notice rewards-failure" role="alert" title={failure.detail}>
          <span>{failureLabel}</span>
          {failure.operation === "load" ? <button className="page-action-secondary" onClick={onRetry} type="button">Retry</button> : null}
        </div> : null}
        {rows.length ? <ul className="rewards-claim-list">
          {rows.map(({ kind, name, claimable, pending }) => (
            <li className="rewards-claim-row" key={kind}>
              <span className="rewards-claim-name">{name}</span>
              <div className="rewards-claim-values">
                {claimable !== null && claimable > 0n ? <div className="rewards-claim-value">
                  <strong>{rewardAmount(claimable)} <small>USDC</small></strong>
                  <button className="page-action-secondary" disabled={!connected || !rewards?.contractId || claiming !== null}
                    onClick={() => onClaim(kind)} type="button">
                    {claiming === kind ? "Claiming…" : "Claim"}
                  </button>
                </div> : null}
                {pending > 0n ? <div className="rewards-claim-value">
                  <strong>{rewardAmount(pending)} <small>USDC</small></strong>
                  <span className="rewards-pending-label" title={rewards?.[kind]
                    ? "Awaiting credit to the rewards contract" : "Accrued rewards; claimable balance has not been published"}>Pending</span>
                </div> : null}
              </div>
            </li>
          ))}
        </ul> : failure?.operation !== "load" ? <div className="page-empty-state" aria-label={loading ? "Loading rewards" : undefined}
          role={loading ? "status" : undefined} title={connected && !loading && !balancesPublished ? "Claimable reward balances have not been published" : undefined}>
          {!connected ? "Connect wallet to view rewards" : loading ? "…" : balancesPublished ? "Nothing to claim"
            : <span aria-label="Claimable reward balances have not been published">—</span>}
        </div> : null}
      </section>
    </main>
  );
}

function rewardRows(rewards: RewardsAccount) {
  return rewardTypes.map(({ rowName, kind }): { kind: RewardKind; name: string; claimable: bigint | null; pending: bigint } => {
    const balance = rewards[kind];
    if (!balance) return { kind, name: rowName, claimable: null, pending: rewards.accrued ? rewardUnits(rewards.accrued[kind]) : 0n };
    const claimable = rewardUnits(balance.claimable), claimed = rewardUnits(balance.claimed), credited = rewardUnits(balance.credited);
    if (claimable + claimed !== credited) throw new Error("Reward balances are out of sync");
    const accrued = rewards.accrued ? rewardUnits(rewards.accrued[kind]) : credited;
    if (accrued < credited) throw new Error("Reward accrual is out of sync");
    return { kind, name: rowName, claimable, pending: accrued - credited };
  });
}

function rewardUnits(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("Reward balance is unavailable");
  return BigInt(value);
}

function rewardAmount(value: bigint | string): string {
  const amount = typeof value === "string" ? rewardUnits(value) : value;
  return `$${formatVaultUnits(amount, amount > 0n && amount < 100_000n ? 7 : 2)}`;
}

function errorDetail(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
