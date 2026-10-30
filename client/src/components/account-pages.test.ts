import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PointsOverview, type PointsSnapshot } from "@/components/points-page";
import { RewardsContent } from "@/components/rewards-page";
import type { RewardsAccount } from "@/lib/rewards";

const standard = { tier: "Standard" as const, threshold: 0, feeRebatePercent: 0, referralSharePercent: 0, creditDropWeight: 1 };
const points: PointsSnapshot = { activePoints: 0, lifetimePoints: 0, benefits: standard, complete: true,
  nextTier: { ...standard, tier: "Silver", threshold: 250 }, tier: "Standard" };
const balance = { claimable: "0", claimed: "0", credited: "0" };
const rewards: RewardsAccount = { contractId: "rewards-contract", rebate: balance, referral: balance,
  accrued: { rebate: "0", referral: "0" } };
const rewardProps = { claiming: null, connected: true, copied: false, failure: null, loading: false,
  onClaim() {}, onCopy() {}, onRetry() {}, referralStatus: null };

describe("points completeness", () => {
  test("keeps genuine zero points and the correct starting progress", () => {
    const markup = renderToStaticMarkup(createElement(PointsOverview, { points }));
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('aria-valuemax="250"');
    expect(markup).toContain("0 / 250");
  });

  test("identifies partial totals without implying a running reconciliation job", () => {
    const markup = renderToStaticMarkup(createElement(PointsOverview, {
      points: { ...points, activePoints: 35, lifetimePoints: 35, complete: false },
    }));
    expect(markup).toContain("35");
    expect(markup).toContain("Verified activity only; some historical settlement details are missing.");
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain("Some settled activity is still being reconciled.");
  });
});

describe("reward claim states", () => {
  test("shows pending credits alongside an existing claimable balance", () => {
    const account = { ...rewards, rebate: { ...balance, claimable: "10000000", credited: "10000000" },
      accrued: { rebate: "20000000", referral: "5000000" } };
    const markup = renderToStaticMarkup(createElement(RewardsContent, { ...rewardProps, rewards: account }));
    expect(markup).toContain(">Claim</button>");
    expect(markup).toContain("$0.50");
    expect(markup.match(/>Pending<\/span>/g)).toHaveLength(2);
  });

  test("distinguishes a real zero reward from an unpublished balance", () => {
    const zero = renderToStaticMarkup(createElement(RewardsContent, { ...rewardProps, rewards }));
    expect(zero).toContain("$0.00");
    expect(zero).toContain("Nothing to claim");
    const missing = renderToStaticMarkup(createElement(RewardsContent, { ...rewardProps,
      rewards: { contractId: null, rebate: null, referral: null, accrued: null } }));
    expect(missing).not.toContain("$0.00");
    expect(missing).not.toContain(">Claim</button>");
    expect(missing).not.toContain("Nothing to claim");
  });

  test("keeps known accrued rewards pending when contract balances are unpublished", () => {
    const markup = renderToStaticMarkup(createElement(RewardsContent, { ...rewardProps,
      rewards: { contractId: null, rebate: null, referral: null, accrued: { rebate: "10000000", referral: "5000000" } } }));
    expect(markup).toContain("$1.00");
    expect(markup).toContain("$0.50");
    expect(markup.match(/>Pending<\/span>/g)).toHaveLength(2);
    expect(markup).not.toContain(">Claim</button>");
    expect(markup).not.toContain("$0.00");
    expect(markup).not.toContain("Nothing to claim");
    expect(markup).not.toContain("No rewards yet");
  });

  test("shows nothing to claim after rewards have been fully claimed", () => {
    const markup = renderToStaticMarkup(createElement(RewardsContent, { ...rewardProps,
      rewards: { ...rewards, rebate: { claimable: "0", claimed: "10000000", credited: "10000000" },
        accrued: { rebate: "10000000", referral: "0" } } }));
    expect(markup).toContain("Nothing to claim");
    expect(markup).not.toContain("No rewards yet");
    expect(markup).not.toContain(">Claim</button>");
  });

  test("prevents a second claim while one is in progress", () => {
    const account = { ...rewards, rebate: { ...balance, claimable: "10000000", credited: "10000000" },
      accrued: { rebate: "10000000", referral: "0" } };
    const markup = renderToStaticMarkup(createElement(RewardsContent, { ...rewardProps, rewards: account, claiming: "rebate" }));
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Claiming…");
  });
});
