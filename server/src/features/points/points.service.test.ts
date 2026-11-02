import { describe, expect, test } from "bun:test";
import { hashFields, ownerCommitment } from "@pnlx/crypto";
import { fillFees, notional, PRICE_SCALE } from "@pnlx/market-math";
import type { BatchSettlement, Hex, IntentRecord, PositionCloseRecord, PositionLifecycleRecord, PrivateMatchIntent } from "@pnlx/protocol-types";
import { confirmedFills, PointsService } from "@/features/points/points.service";
import { FEE_CONFIG_HASH } from "@/shared/protocol/fee-config";
import { ProtocolStore } from "@/shared/state/store";
import { assertPrivateMatchIntent, matchingPayloadCommitment } from "@/workers/batch-matcher/private-intent";

const MAKER = `0x${"11".repeat(32)}` as Hex;
const TAKER = `0x${"22".repeat(32)}` as Hex;
const MAKER_INTENT = `0x${"33".repeat(32)}` as Hex;
const TAKER_INTENT = `0x${"44".repeat(32)}` as Hex;
const DIGEST = `0x${"55".repeat(32)}` as Hex;
const SIZE = 5_000n * 10_000_000n;
const PRICE = PRICE_SCALE / 5n;
const NOW = Date.UTC(2026, 8, 26, 12);

function fixture(): { store: ProtocolStore; settlement: BatchSettlement } {
  const store = new ProtocolStore();
  const maker = { intentCommitment: MAKER_INTENT, ownerCommitment: MAKER, signedSize: SIZE };
  const taker = { intentCommitment: TAKER_INTENT, ownerCommitment: TAKER, signedSize: -SIZE };
  for (const intent of [maker, taker]) {
    const payload = {
      batchId: "batch",
      intentCommitment: intent.intentCommitment,
      limitPrice: PRICE,
      margin: 100n * 10_000_000n,
      marketId: "xlm-usd-perp",
      noteChangeCommitment: `0x${"00".repeat(32)}`,
      noteNullifier: `0x${"66".repeat(32)}`,
      ownerCommitment: intent.ownerCommitment,
      ownerDigest: hashFields("fixture-owner-digest", [intent.ownerCommitment]),
      positionSeed: hashFields("fixture-position-seed", [intent.intentCommitment]),
      signedSize: intent.signedSize,
    } satisfies PrivateMatchIntent;
    store.privateMatchIntents.set(intent.intentCommitment, payload);
    store.intents.set(intent.intentCommitment, {
      batchId: "batch", intentCommitment: intent.intentCommitment,
      marketId: "xlm-usd-perp", matchingPayloadCommitment: matchingPayloadCommitment(payload),
      noteChangeCommitment: payload.noteChangeCommitment, noteNullifier: payload.noteNullifier,
      ownerCommitment: payload.ownerCommitment,
    } as IntentRecord);
  }
  const fees = fillFees(SIZE, PRICE);
  const settlement = {
    aggregateVolume: 2n * SIZE,
    feeConfigHash: FEE_CONFIG_HASH,
    grossTakerFee: fees.grossTakerFee,
    insuranceFee: fees.insurance,
    makerIntents: [MAKER_INTENT],
    makerRebate: fees.makerRebate,
    marketId: "xlm-usd-perp",
    matchingPayloadCommitments: [
      matchingPayloadCommitment(store.privateMatchIntents.get(MAKER_INTENT)!),
      matchingPayloadCommitment(store.privateMatchIntents.get(TAKER_INTENT)!),
    ],
    onchainConfirmed: true,
    settlementDigest: DIGEST,
    takerIntents: [TAKER_INTENT],
    treasuryFee: fees.treasury,
  } as BatchSettlement;
  store.settlements.set("xlm-usd-perp:batch", settlement);
  store.marketSettlementVolumes.set(DIGEST, {
    marketId: "xlm-usd-perp", matchedVolume: SIZE, settledAt: NOW, settlementDigest: DIGEST,
  });
  return { store, settlement };
}

describe("confirmed trade points", () => {
  test("credits both sides of a confirmed fill without exposing the counterparty", () => {
    const { store } = fixture();
    expect(notional(SIZE, PRICE)).toBe(1_000n * 10_000_000n);
    const taker = new PointsService(store).snapshot(TAKER, NOW + 1);
    const maker = new PointsService(store).snapshot(MAKER, NOW + 1);
    expect(taker.activePoints).toBe(100);
    expect(maker.activePoints).toBe(100);
    expect(taker.tier).toBe("Standard");
    expect(taker.days).toEqual([{ date: "2026-09-26", makerNotional: "0", points: 100,
      takerNotional: notional(SIZE, PRICE).toString() }]);
  });

  test("does not award points for unconfirmed or unreconciled settlement data", () => {
    const { store, settlement } = fixture();
    store.settlements.set("xlm-usd-perp:batch", { ...settlement, onchainConfirmed: false });
    expect(new PointsService(store).snapshot(TAKER, NOW + 1).lifetimePoints).toBe(0);
    store.settlements.set("xlm-usd-perp:batch", { ...settlement, grossTakerFee: settlement.grossTakerFee + 1n });
    const unreconciled = new PointsService(store).snapshot(TAKER, NOW + 1);
    expect(unreconciled.lifetimePoints).toBe(0);
    expect(unreconciled.complete).toBe(false);
    store.settlements.set("xlm-usd-perp:batch", { ...settlement, feeConfigHash: DIGEST });
    expect(new PointsService(store).snapshot(TAKER, NOW + 1).complete).toBe(false);
  });

  test("validates historical payload hashes without allowing those payloads through the current order validator", () => {
    const { store, settlement } = fixture();
    const commitments: Hex[] = [];
    for (const id of [MAKER_INTENT, TAKER_INTENT]) {
      const current = store.privateMatchIntents.get(id)!;
      const { ownerDigest: _ownerDigest, positionSeed: _positionSeed, ...historical } = current;
      const commitment = hashFields("matching-payload", [historical.intentCommitment, historical.marketId,
        historical.ownerCommitment, historical.signedSize, historical.limitPrice, historical.margin,
        historical.noteNullifier, historical.noteChangeCommitment, historical.sourceIntentCommitment ?? "0x0"]);
      commitments.push(commitment);
      store.privateMatchIntents.set(id, historical as PrivateMatchIntent);
      store.intents.set(id, { ...store.intents.get(id)!, matchingPayloadCommitment: commitment });
      expect(() => assertPrivateMatchIntent(store.intents.get(id)!, historical as PrivateMatchIntent)).toThrow();
    }
    const historicalSettlement = { ...settlement, matchingPayloadCommitments: commitments };
    store.settlements.set("xlm-usd-perp:batch", historicalSettlement);
    expect(new PointsService(store).snapshot(TAKER, NOW + 1)).toMatchObject({ activePoints: 100, complete: true });
    store.privateMatchIntents.set(TAKER_INTENT, { ...store.privateMatchIntents.get(TAKER_INTENT)!, margin: 1n });
    expect(confirmedFills(historicalSettlement, store)).toBeNull();
  });

  test("unrelated incomplete settlements cannot mark this wallet's points incomplete", () => {
    const { store, settlement } = fixture();
    store.settlements.set("xlm-usd-perp:unrelated", { ...settlement,
      settlementDigest: `0x${"99".repeat(32)}`, makerIntents: [], takerIntents: [],
      matchingPayloadCommitments: [], newCommitments: [] });
    expect(new PointsService(store).snapshot(TAKER, NOW + 1)).toMatchObject({ activePoints: 100, complete: true });
    store.settlements.set("xlm-usd-perp:related", { ...settlement, settlementDigest: `0x${"88".repeat(32)}` });
    expect(new PointsService(store).snapshot(TAKER, NOW + 1).complete).toBe(false);
  });

  test("does not award both sides to the same owner", () => {
    const { store } = fixture();
    store.privateMatchIntents.set(TAKER_INTENT, {
      ...store.privateMatchIntents.get(TAKER_INTENT)!, ownerCommitment: MAKER,
    });
    expect(new PointsService(store).snapshot(MAKER, NOW + 1).lifetimePoints).toBe(0);
  });

  test("keeps lifetime points after a settled fill leaves the 90-day window", () => {
    const { store } = fixture();
    const result = new PointsService(store).snapshot(TAKER, NOW + 91 * 86_400_000);
    expect(result.activePoints).toBe(0);
    expect(result.lifetimePoints).toBe(100);
  });

  test("counts each confirmed close cycle while awarding one weekly bonus", () => {
    const { store } = fixture();
    store.settlements.clear();
    for (let index = 0; index < 2; index += 1) {
      const positionCommitment = `0x${String(index + 7).repeat(64)}` as Hex;
      const closeCommitment = `0x${String(index + 9).repeat(64)}` as Hex;
      store.positionLifecycle.set(positionCommitment, {
        closeCommitment,
        ownerCommitment: TAKER,
        positionCommitment,
        status: "closed",
        updatedAt: NOW,
      } as PositionLifecycleRecord);
      store.positionCloses.set(closeCommitment, {
        closeCommitment,
        settlementTxHash: DIGEST,
      } as PositionCloseRecord);
    }
    const result = new PointsService(store).snapshot(TAKER, NOW + 1);
    expect(result.lifetimePoints).toBe(25);
    expect(result.days[0]?.points).toBe(25);
  });

  test("excludes the configured PNLX maker from personal tier points", () => {
    const { store } = fixture();
    const makerAddress = "GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";
    const makerOwner = ownerCommitment(makerAddress);
    store.privateMatchIntents.set(MAKER_INTENT, {
      ...store.privateMatchIntents.get(MAKER_INTENT)!, ownerCommitment: makerOwner,
    });
    const record = store.intents.get(MAKER_INTENT)!;
    store.intents.set(MAKER_INTENT, {
      ...record,
      ownerCommitment: makerOwner,
      matchingPayloadCommitment: matchingPayloadCommitment(store.privateMatchIntents.get(MAKER_INTENT)!),
    });
    const settlement = store.settlements.get("xlm-usd-perp:batch")!;
    store.settlements.set("xlm-usd-perp:batch", {
      ...settlement,
      matchingPayloadCommitments: [
        matchingPayloadCommitment(store.privateMatchIntents.get(MAKER_INTENT)!),
        matchingPayloadCommitment(store.privateMatchIntents.get(TAKER_INTENT)!),
      ],
    });
    expect(new PointsService(store, makerAddress).snapshot(makerOwner, NOW + 1).lifetimePoints).toBe(0);
    expect(new PointsService(store, makerAddress).snapshot(TAKER, NOW + 1).lifetimePoints).toBe(100);
  });
});
