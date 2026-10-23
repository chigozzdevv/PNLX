import { hashFields } from "@pnlx/crypto";
import { describe, expect, test } from "bun:test";
import { fillFees, PRICE_SCALE } from "@pnlx/market-math";
import type { BatchSettlement, Hex, IntentRecord, PrivateMatchIntent } from "@pnlx/protocol-types";
import { RewardAccrualService } from "@/features/rewards/rewards.accrual";
import { FEE_CONFIG_HASH } from "@/shared/protocol/fee-config";
import { ProtocolStore } from "@/shared/state/store";
import { matchingPayloadCommitment } from "@/workers/batch-matcher/private-intent";

const MAKER = `0x${"11".repeat(32)}` as Hex;
const TAKER = `0x${"22".repeat(32)}` as Hex;
const OTHER = `0x${"77".repeat(32)}` as Hex;
const SIZE = 5_000n * 10_000_000n;
const PRICE = PRICE_SCALE / 5n;
const START = Date.UTC(2026, 8, 20, 12);

function addFill(store: ProtocolStore, number: number, makerOwner = MAKER): BatchSettlement {
  const makerId = `0x${number.toString(16).padStart(64, "0")}` as Hex;
  const takerId = `0x${(number + 100).toString(16).padStart(64, "0")}` as Hex;
  const digest = `0x${(number + 200).toString(16).padStart(64, "0")}` as Hex;
  for (const [id, owner, signedSize] of [[makerId, makerOwner, SIZE], [takerId, TAKER, -SIZE]] as const) {
    const payload = { batchId: `batch-${number}`, intentCommitment: id, limitPrice: PRICE,
      margin: 100n * 10_000_000n, marketId: "xlm-usd-perp",
      noteChangeCommitment: `0x${"00".repeat(32)}` as Hex,
      noteNullifier: `0x${"66".repeat(32)}` as Hex,
      ownerCommitment: owner, ownerDigest: hashFields("fixture-owner-digest", [owner]),
      positionSeed: hashFields("fixture-position-seed", [id]), signedSize } satisfies PrivateMatchIntent;
    store.privateMatchIntents.set(id, payload);
    store.intents.set(id, { batchId: payload.batchId, intentCommitment: id,
      marketId: payload.marketId, matchingPayloadCommitment: matchingPayloadCommitment(payload),
      noteChangeCommitment: payload.noteChangeCommitment, noteNullifier: payload.noteNullifier,
      ownerCommitment: owner } as IntentRecord);
  }
  const fees = fillFees(SIZE, PRICE);
  const settlement = { aggregateVolume: 2n * SIZE, feeConfigHash: FEE_CONFIG_HASH,
    grossTakerFee: fees.grossTakerFee, insuranceFee: fees.insurance,
    makerIntents: [makerId], makerRebate: fees.makerRebate, marketId: "xlm-usd-perp",
    matchingPayloadCommitments: [matchingPayloadCommitment(store.privateMatchIntents.get(makerId)!),
      matchingPayloadCommitment(store.privateMatchIntents.get(takerId)!)],
    onchainConfirmed: true, settlementDigest: digest, takerIntents: [takerId], treasuryFee: fees.treasury } as BatchSettlement;
  store.settlements.set(`xlm-usd-perp:batch-${number}`, settlement);
  store.marketSettlementVolumes.set(digest, { marketId: "xlm-usd-perp", matchedVolume: SIZE,
    settledAt: START + number * 86_400_000, settlementDigest: digest });
  return settlement;
}

describe("reward accrual", () => {
  test("rebates only confirmed fees after the account reaches a tier", () => {
    const store = new ProtocolStore();
    for (let number = 0; number < 4; number += 1) addFill(store, number);
    const result = new RewardAccrualService(store).forOwner(TAKER, [], START + 4 * 86_400_000);
    const fees = fillFees(SIZE, PRICE);
    expect(result.rebate).toBe(fees.grossTakerFee * 5n / 100n);
    expect(result.eligibleTreasuryFees).toBe(fees.treasury * 4n);
    expect(result.complete).toBe(true);
  });

  test("excludes invalid and unconfirmed settlements", () => {
    const store = new ProtocolStore();
    for (let number = 0; number < 4; number += 1) addFill(store, number);
    const fourth = store.settlements.get("xlm-usd-perp:batch-3")!;
    store.settlements.set("xlm-usd-perp:batch-3", { ...fourth, onchainConfirmed: false });
    expect(new RewardAccrualService(store).forOwner(TAKER, [], START + 4 * 86_400_000).rebate).toBe(0n);
    store.settlements.set("xlm-usd-perp:batch-3", { ...fourth, grossTakerFee: fourth.grossTakerFee + 1n });
    const result = new RewardAccrualService(store).forOwner(TAKER, [], START + 4 * 86_400_000);
    expect(result.rebate).toBe(0n);
    expect(result.complete).toBe(false);
  });

  test("pays referral share only for a pre-registered external taker", () => {
    const store = new ProtocolStore();
    for (let number = 0; number < 3; number += 1) addFill(store, number);
    addFill(store, 3, OTHER);
    const referrals = [{ _id: TAKER, referred: TAKER, referrer: MAKER, registeredAt: START - 1 }];
    const result = new RewardAccrualService(store).forOwner(MAKER, referrals, START + 4 * 86_400_000);
    expect(result.referral).toBe(fillFees(SIZE, PRICE).treasury * 5n / 100n);
    expect(new RewardAccrualService(store).forOwner(MAKER,
      [{ ...referrals[0], registeredAt: START + 4 * 86_400_000 }],
      START + 4 * 86_400_000).referral).toBe(0n);
  });

  test("calculates Gold's fractional referral percentage", () => {
    const store = new ProtocolStore();
    for (let number = 0; number < 10; number += 1) addFill(store, number);
    addFill(store, 10, OTHER);
    const referrals = [{ _id: TAKER, referred: TAKER, referrer: MAKER, registeredAt: START - 1 }];
    const result = new RewardAccrualService(store).forOwner(MAKER, referrals, START + 11 * 86_400_000);
    expect(result.referral).toBe(fillFees(SIZE, PRICE).treasury * 750n / 10_000n);
  });
});
