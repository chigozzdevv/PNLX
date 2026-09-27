"use client";

import { Percent, Ticket, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { BottomTicker } from "@/components/bottom-ticker";
import { useMarketTicker } from "@/lib/use-market-ticker";
import { useWalletSession } from "@/lib/use-wallet-session";
import { claimReward, getRewards, type RewardKind, type RewardsAccount } from "@/lib/rewards";
import { formatVaultUnits } from "@/lib/liquidity-vault";
import { pnlxPost } from "@/lib/pnlx-api";

const rewardTypes = [
  { name: "Fee rebates", metric: "Claimable", icon: Percent, style: "rebate", kind: "rebate" },
  { name: "Referral earnings", metric: "Claimable", icon: UsersRound, style: "referral", kind: "referral" },
  { name: "Credit Drops", metric: "Available", icon: Ticket, style: "credit", kind: null },
] as const;

export function RewardsPage() {
  const wallet = useWalletSession();
  const ticker = useMarketTicker();
  const [loaded, setLoaded] = useState<{ address: string; rewards: RewardsAccount } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState<RewardKind | null>(null);
  const [referralStatus, setReferralStatus] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    const session = wallet.session;
    if (!session) return;
    let active = true;
    const load = () => void getRewards(session).then((rewards) => {
      if (active) { setLoaded({ address: session.address, rewards }); setError(null); }
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Rewards unavailable"); });
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [wallet.session]);

  useEffect(() => {
    const session = wallet.session;
    if (!session) return;
    const referrer = new URLSearchParams(window.location.search).get("ref");
    if (!referrer) return;
    let active = true;
    void pnlxPost<{ registeredAt: number }>("/rewards/referral", { referrer }, session.token)
      .then(() => { if (active) setReferralStatus("Referral linked"); })
      .catch((cause) => { if (active) setReferralStatus(cause instanceof Error ? cause.message : "Referral unavailable"); });
    return () => { active = false; };
  }, [wallet.session]);

  const rewards = loaded && loaded.address === wallet.session?.address ? loaded.rewards : null;
  const available = (["rebate", "referral"] as const).filter((kind) =>
    rewards?.[kind] && BigInt(rewards[kind].claimable) > 0n);
  const pending = (["rebate", "referral"] as const).filter((kind) =>
    rewards?.accrued && rewards[kind] &&
    BigInt(rewards.accrued[kind]) > BigInt(rewards[kind].credited));

  async function onClaim(kind: RewardKind) {
    if (!wallet.session || !rewards?.contractId || claiming) return;
    setClaiming(kind);
    setError(null);
    try {
      await claimReward(wallet.session, kind, rewards.contractId);
      setLoaded({ address: wallet.session.address, rewards: await getRewards(wallet.session) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Reward claim failed");
    } finally {
      setClaiming(null);
    }
  }

  async function copyReferralLink() {
    if (!wallet.session) return;
    await navigator.clipboard.writeText(`${window.location.origin}/rewards?ref=${wallet.session.address}`);
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 2_000);
  }

  return (
    <AppShell activeView="rewards" wallet={wallet}>
      <main className="rewards-page">
        <h1>Rewards</h1>

        <section aria-label="Reward balances" className="rewards-cards">
          {rewardTypes.map(({ name, metric, icon: Icon, style, kind }) => (
            <article className={`rewards-card rewards-card-${style}`} key={name}>
              <Icon aria-hidden="true" className="rewards-card-art" strokeWidth={1} />
              <div className="rewards-card-content">
                <span className="rewards-card-title">{name}</span>
                <div className="rewards-card-balance">
                  <small>{metric}</small>
                  <strong aria-label={`${name} ${kind && rewards?.[kind] ? "claimable amount" : "amount unavailable"}`}>
                    {kind && rewards?.[kind] ? `$${formatVaultUnits(rewards[kind].claimable)}` : "—"}
                  </strong>
                </div>
              </div>
            </article>
          ))}
        </section>

        {wallet.session ? <div className="rewards-referral-link">
          <button onClick={() => void copyReferralLink()} type="button">{linkCopied ? "Copied" : "Copy referral link"}</button>
          {referralStatus ? <span role="status">{referralStatus}</span> : null}
        </div> : null}

        <section aria-label="Available rewards" className="rewards-history">
          <h2>Available rewards</h2>
          {error ? <p role="alert">{error}</p> : null}
          <div className="rewards-table-scroll">
            <table className="rewards-table">
              <thead><tr>
                <th scope="col">Reward</th>
                <th scope="col">Kind</th>
                <th scope="col">Amount</th>
                <th scope="col">Action</th>
              </tr></thead>
              <tbody>{available.length ? available.map((kind) => <tr key={kind}>
                <td>{kind === "rebate" ? "Fee rebate" : "Referral earnings"}</td>
                <td>USDC</td>
                <td>${formatVaultUnits(rewards![kind]!.claimable)}</td>
                <td><button disabled={claiming !== null} onClick={() => void onClaim(kind)} type="button">
                  {claiming === kind ? "Claiming…" : "Claim"}
                </button></td>
              </tr>) : pending.length ? pending.map((kind) => <tr key={kind}>
                <td>{kind === "rebate" ? "Fee rebate" : "Referral earnings"}</td>
                <td>USDC</td>
                <td>${formatVaultUnits((BigInt(rewards!.accrued![kind]) - BigInt(rewards![kind]!.credited)).toString())}</td>
                <td>Pending</td>
              </tr>) : <tr><td className="rewards-table-empty" colSpan={4}>
                {!wallet.session ? "Connect your wallet to view rewards." :
                  rewards?.contractId ? "No rewards available to claim." : "Rewards are not available yet."}
              </td></tr>}</tbody>
            </table>
          </div>
        </section>
      </main>
      <BottomTicker ticker={ticker.ticker} updatedAt={ticker.updatedAt} />
    </AppShell>
  );
}
