import { describe, expect, test } from "bun:test";
import { circuitPositionCommitment, digestToFieldHex, fieldHex, hashFields, ownerCommitment, positionSecrets } from "@pnlx/crypto";
import { PRICE_SCALE } from "@pnlx/market-math";
import type { BatchSettlement, Hex, IntentRecord, PositionLifecycleRecord, PrivateMatchIntent } from "@pnlx/protocol-types";
import { PortfolioController } from "@/features/portfolio/portfolio.controller";
import { PortfolioService } from "@/features/portfolio/portfolio.service";
import { walletTradedVolume } from "@/features/portfolio/wallet-volume";
import { setAuthenticatedAddress } from "@/shared/http/auth-context";
import { ProtocolStore } from "@/shared/state/store";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { matchingPayloadCommitment } from "@/workers/batch-matcher/private-intent";
import { ExecutorService } from "@/workers/executor/executor.service";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";

const UNIT = 10_000_000n;
const ALICE = ownerCommitment("GALICE"), BOB = ownerCommitment("GBOB"), CAROL = ownerCommitment("GCAROL");
const market = { marketId: "xlm-usd-perp", fundingIndex: 0n, oraclePrice: 2n * PRICE_SCALE,
  initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };

function intent(label: string, signedSize: bigint, owner = ALICE, price = 2n * PRICE_SCALE): PrivateMatchIntent {
  return {
    batchId: label, marketId: market.marketId, intentCommitment: hashFields("volume-intent", [label]),
    noteNullifier: hashFields("volume-nullifier", [label]), noteChangeCommitment: "0x0",
    ownerCommitment: owner, ownerDigest: digestToFieldHex(`owner:${owner}`),
    positionSeed: digestToFieldHex(`position:${label}`), signedSize, limitPrice: price,
    margin: signedSize < 0n ? -signedSize : signedSize,
  };
}

function addBatch(store: ProtocolStore, batchId: string, intents: PrivateMatchIntent[]) {
  const match = new BatchMatcherService().match({ batchId, market, intents });
  const draft = prepareRisc0SettlementDraft({ batchId, market, intents, match });
  const proof = { circuitId: "batch-match", circuitKey: hashFields("test", [0]), circuitHash: hashFields("test", [1]),
    verifierHash: hashFields("test", [2]), publicInputHash: hashFields("test", [3]),
    proofDigest: hashFields("test", [4]) };
  const settlement: BatchSettlement = { ...draft, onchainConfirmed: true, proof };
  store.settlements.set(`${market.marketId}:${batchId}`, settlement);
  for (const payload of intents) {
    store.privateMatchIntents.set(payload.intentCommitment, payload);
    if (!store.residualOrders.has(payload.intentCommitment)) store.intents.set(payload.intentCommitment, {
      ...payload, matchingPayloadCommitment: matchingPayloadCommitment(payload),
    } as unknown as IntentRecord);
  }
  const positions: PositionLifecycleRecord[] = match.fills.map((fill) => ({
    batchId, marketId: market.marketId, openedAt: 1, updatedAt: 1, status: "open",
    ownerCommitment: fill.ownerCommitment, positionCommitment: fill.positionCommitment,
    positionNullifier: fill.positionNullifier, sourceIntentCommitment: fill.intentCommitment,
    settlementDigest: settlement.settlementDigest, fundingIndex: 0n,
  }));
  for (const position of positions) store.positionLifecycle.set(position.positionCommitment, position);
  for (const update of match.orderUpdates) {
    const payload = intents.find((value) => value.intentCommitment === update.intentCommitment)!;
    store.orderLifecycle.set(update.intentCommitment, { ...update, batchId, marketId: market.marketId,
      ownerCommitment: payload.ownerCommitment, createdAt: 1, updatedAt: 1 });
  }
  for (const residual of match.residuals) {
    store.privateMatchIntents.set(residual.intentCommitment, residual);
    store.residualOrders.set(residual.intentCommitment, { ...residual, createdAt: 1, updatedAt: 1,
      sourceIntentCommitment: residual.sourceIntentCommitment!, matchingPayloadCommitment: matchingPayloadCommitment(residual) });
    store.orderLifecycle.set(residual.intentCommitment, { batchId, marketId: market.marketId,
      intentCommitment: residual.intentCommitment, ownerCommitment: residual.ownerCommitment,
      status: "open", createdAt: 1, updatedAt: 1 });
  }
  return { settlement, positions, match };
}

// Exact persisted payload format used before 58f9cbe; position commitments are opaque here.
function makeLegacy(store: ProtocolStore, batches: Array<ReturnType<typeof addBatch>>) {
  const bindings = new Map<Hex, Hex>();
  for (const payload of store.privateMatchIntents.values()) {
    const oldBinding = hashFields("matching-payload", [payload.intentCommitment, payload.marketId, payload.ownerCommitment,
      payload.signedSize, payload.limitPrice, payload.margin, payload.noteNullifier, payload.noteChangeCommitment,
      payload.sourceIntentCommitment ?? "0x0"]);
    bindings.set(matchingPayloadCommitment(payload), oldBinding);
    const record = store.intents.get(payload.intentCommitment) ?? store.residualOrders.get(payload.intentCommitment);
    if (record) record.matchingPayloadCommitment = oldBinding;
    Reflect.deleteProperty(payload, "ownerDigest"); Reflect.deleteProperty(payload, "positionSeed");
  }
  for (const { settlement } of batches) {
    settlement.matchingPayloadCommitments = settlement.matchingPayloadCommitments.map((value) => bindings.get(value)!);
    for (let index = 0; index < settlement.newCommitments.length; index += 2) {
      const pair = settlement.newCommitments.slice(index, index + 2).sort((left, right) => {
        const a = store.privateMatchIntents.get(store.positionLifecycle.get(left)!.sourceIntentCommitment)!;
        const b = store.privateMatchIntents.get(store.positionLifecycle.get(right)!.sourceIntentCommitment)!;
        return a.signedSize > b.signedSize ? -1 : 1;
      });
      settlement.newCommitments.splice(index, 2, ...pair);
    }
  }
}

describe("authenticated wallet traded volume", () => {
  test("a genuinely empty, pending or cancelled history is available zero", () => {
    const store = new ProtocolStore();
    const pending = intent("pending", UNIT);
    store.orderLifecycle.set(pending.intentCommitment, { batchId: "pending", marketId: market.marketId,
      intentCommitment: pending.intentCommitment, ownerCommitment: ALICE, status: "open", createdAt: 1, updatedAt: 1 });
    expect(walletTradedVolume(store, ALICE)).toEqual({ amount: 0n, status: "available", source: "pnlx-confirmed-fills" });
    store.orderLifecycle.get(pending.intentCommitment)!.status = "cancelled";
    expect(walletTradedVolume(store, ALICE).amount).toBe(0n);
  });

  test("uses actual execution price, counts each wallet side and retains closed or liquidated fills", () => {
    const store = new ProtocolStore();
    const { positions, settlement } = addBatch(store, "history", [intent("maker", 3n * UNIT),
      intent("taker", -3n * UNIT, BOB, 150_000_000n)]);
    positions[0].status = "closed";
    positions[1].status = "liquidated";
    settlement.feeConfigHash = hashFields("historical-fee-config", [1]);
    expect(walletTradedVolume(store, ALICE).amount).toBe(6n * UNIT);
    expect(walletTradedVolume(store, BOB).amount).toBe(6n * UNIT);
    expect(walletTradedVolume(store, CAROL).amount).toBe(0n);
    expect(store.accountEvents.size).toBe(0);
  });

  test("counts distinct partial fills and a later residual fill, never the original unfilled size", () => {
    const store = new ProtocolStore();
    const first = addBatch(store, "partial", [intent("large", 10n * UNIT),
      intent("short-a", -3n * UNIT, BOB), intent("short-b", -2n * UNIT, CAROL)]);
    expect(walletTradedVolume(store, ALICE).amount).toBe(10n * UNIT);
    const residual = first.match.residuals[0];
    const second = addBatch(store, "residual", [residual, intent("short-c", -2n * UNIT, BOB)]);
    expect(walletTradedVolume(store, ALICE).amount).toBe(14n * UNIT);
    const finalResidual = second.match.residuals[0];
    store.orderLifecycle.get(finalResidual.intentCommitment)!.status = "cancelled";
    expect(walletTradedVolume(store, ALICE).amount).toBe(14n * UNIT);
  });

  test("counts two distinct self-trade legs once each without points exclusions", () => {
    const store = new ProtocolStore();
    addBatch(store, "same-owner", [intent("self-long", UNIT), intent("self-short", -UNIT)]);
    expect(walletTradedVolume(store, ALICE).amount).toBe(4n * UNIT);
  });

  test("deduplicates exact settlement aliases and rejects conflicting history", () => {
    const store = new ProtocolStore();
    const { settlement } = addBatch(store, "duplicate", [intent("dup-long", UNIT), intent("dup-short", -UNIT, BOB)]);
    store.settlements.set("alias", { ...settlement });
    expect(walletTradedVolume(store, ALICE).amount).toBe(2n * UNIT);
    expect(walletTradedVolume(store, ALICE).amount).toBe(2n * UNIT);
    store.settlements.set("conflict", { ...settlement, aggregateVolume: 4n * UNIT });
    expect(walletTradedVolume(store, ALICE)).toMatchObject({ status: "incomplete", amount: null });
    store.settlements.delete("conflict");
    store.settlements.set("fee-conflict", { ...settlement, makerRebate: settlement.makerRebate + 1n });
    expect(walletTradedVolume(store, ALICE).amount).toBeNull();
  });

  test("unrelated missing or malformed settlement data does not make a wallet incomplete", () => {
    const store = new ProtocolStore();
    addBatch(store, "own", [intent("own-long", UNIT), intent("own-short", -UNIT, BOB)]);
    const foreign = addBatch(store, "foreign", [intent("foreign-long", UNIT, BOB), intent("foreign-short", -UNIT, CAROL)]);
    store.privateMatchIntents.delete(foreign.positions[0].sourceIntentCommitment);
    foreign.settlement.onchainConfirmed = false;
    expect(walletTradedVolume(store, ALICE).amount).toBe(2n * UNIT);
    expect(walletTradedVolume(store, BOB).status).toBe("incomplete");
    store.settlements.set("malformed-foreign", { settlementDigest: hashFields("bad", [1]),
      newCommitments: "invalid", makerIntents: "invalid", orderUpdates: "invalid" } as unknown as BatchSettlement);
    expect(walletTradedVolume(store, ALICE).amount).toBe(2n * UNIT);
  });

  test("missing own payloads, positions, settlements or confirmation cannot become zero", () => {
    for (const missing of ["payload", "position", "settlement", "confirmation", "unconfirmed"] as const) {
      const store = new ProtocolStore();
      const { settlement, positions } = addBatch(store, `missing-${missing}`,
        [intent(`long-${missing}`, UNIT), intent(`short-${missing}`, -UNIT, BOB)]);
      const ownPosition = positions.find((position) => position.ownerCommitment === ALICE)!;
      if (missing === "payload") store.privateMatchIntents.delete(ownPosition.sourceIntentCommitment);
      if (missing === "position") store.positionLifecycle.delete(ownPosition.positionCommitment);
      if (missing === "settlement") store.settlements.clear();
      if (missing === "confirmation") delete settlement.onchainConfirmed;
      if (missing === "unconfirmed") settlement.onchainConfirmed = false;
      expect(walletTradedVolume(store, ALICE)).toMatchObject({ status: "incomplete", amount: null });
    }
  });

  test("rejects payload tampering, incorrect position openings and inconsistent aggregate totals", () => {
    for (const corruption of ["payload", "position", "aggregate"] as const) {
      const store = new ProtocolStore();
      const { settlement, positions } = addBatch(store, `corrupt-${corruption}`,
        [intent(`long-${corruption}`, UNIT), intent(`short-${corruption}`, -UNIT, BOB)]);
      if (corruption === "payload") store.privateMatchIntents.get(positions[0].sourceIntentCommitment)!.limitPrice += 1n;
      if (corruption === "position") positions[0].fundingIndex = 1n;
      if (corruption === "aggregate") settlement.aggregateVolume += 2n;
      expect(walletTradedVolume(store, ALICE).amount).toBeNull();
    }
  });

  test("reconstructs a bound legacy fee-free equal-price pair without maker attribution", () => {
    const store = new ProtocolStore();
    const { settlement, positions } = addBatch(store, "legacy", [intent("legacy-long", UNIT), intent("legacy-short", -UNIT, BOB)]);
    settlement.makerIntents = []; settlement.takerIntents = []; settlement.grossTakerFee = 0n;
    settlement.settlementDigest = hashFields("legacy-settlement", [1]);
    for (const [index, position] of positions.entries()) {
      const payload = store.privateMatchIntents.get(position.sourceIntentCommitment)!;
      const secrets = positionSecrets(payload.positionSeed, index);
      const commitment = circuitPositionCommitment({ ...secrets, ownerDigest: payload.ownerDigest,
        entryPrice: payload.limitPrice, margin: payload.margin, fundingIndex: 0n,
        marketDigest: fieldHex(BigInt(hashFields("market-id", [market.marketId]))),
        size: UNIT, side: payload.signedSize > 0n ? "long" : "short" });
      store.positionLifecycle.delete(position.positionCommitment);
      position.positionCommitment = commitment; position.settlementDigest = settlement.settlementDigest;
      settlement.newCommitments[index] = commitment;
      store.positionLifecycle.set(commitment, position);
    }
    expect(walletTradedVolume(store, ALICE).amount).toBe(2n * UNIT);
  });

  test("decodes confirmed legacy fee-bearing history without modern entropy or recoverable private openings", () => {
    const store = new ProtocolStore();
    const batches = [
      addBatch(store, "old-a", [intent("old-a-long", 3n * UNIT), intent("old-a-short", -3n * UNIT, BOB)]),
      addBatch(store, "old-b", [intent("old-b-short", -4n * UNIT, BOB, 150_000_000n), intent("old-b-long", 4n * UNIT)]),
      addBatch(store, "old-c", [intent("old-c-long", 2n * UNIT, CAROL, 225_000_000n), intent("old-c-short", -2n * UNIT)]),
    ];
    makeLegacy(store, batches);
    for (const position of store.positionLifecycle.values()) { position.status = "closed"; delete position.fundingIndex; }
    expect(walletTradedVolume(store, ALICE)).toEqual({ amount: 165_000_000n, status: "available", source: "pnlx-confirmed-fills" });
    expect(store.accountEvents.size).toBe(0);
    store.settlements.set("legacy-alias", { ...batches[0].settlement });
    expect(walletTradedVolume(store, ALICE).amount).toBe(165_000_000n);
  });

  test("legacy multi-fill and residual history uses remaining execution size", () => {
    const store = new ProtocolStore();
    const first = addBatch(store, "old-partial", [intent("old-large", 10n * UNIT),
      intent("old-short-a", -3n * UNIT, BOB), intent("old-short-b", -2n * UNIT, CAROL)]);
    const second = addBatch(store, "old-residual", [first.match.residuals[0], intent("old-short-c", -2n * UNIT, BOB)]);
    makeLegacy(store, [first, second]);
    expect(walletTradedVolume(store, ALICE).amount).toBe(14n * UNIT);
  });

  test("legacy fee-free history needs an unambiguous equal execution price", () => {
    for (const equalPrice of [true, false]) {
      const store = new ProtocolStore();
      const batch = addBatch(store, `old-no-fee-${equalPrice}`, [intent(`old-nf-long-${equalPrice}`, UNIT),
        intent(`old-nf-short-${equalPrice}`, -UNIT, BOB, equalPrice ? 200_000_000n : 150_000_000n)]);
      makeLegacy(store, [batch]);
      batch.settlement.makerIntents = []; batch.settlement.takerIntents = [];
      batch.settlement.grossTakerFee = 0n; batch.settlement.makerRebate = 0n;
      batch.settlement.insuranceFee = 0n; batch.settlement.treasuryFee = 0n;
      expect(walletTradedVolume(store, ALICE).amount).toBe(equalPrice ? 2n * UNIT : null);
    }
  });

  test("legacy payloads require both original bindings, exact attribution, totals and all four fees", () => {
    for (const corruption of ["payload", "record", "settlement", "maker", "aggregate", "grossTakerFee", "makerRebate", "insuranceFee", "treasuryFee"] as const) {
      const store = new ProtocolStore();
      const batch = addBatch(store, `old-corrupt-${corruption}`, [intent(`old-cl-${corruption}`, UNIT), intent(`old-cs-${corruption}`, -UNIT, BOB)]);
      makeLegacy(store, [batch]);
      if (corruption === "payload") store.privateMatchIntents.get(batch.positions[0].sourceIntentCommitment)!.limitPrice += 1n;
      else if (corruption === "record") store.intents.get(batch.positions[0].sourceIntentCommitment)!.matchingPayloadCommitment = hashFields("wrong", [1]);
      else if (corruption === "settlement") batch.settlement.matchingPayloadCommitments = [];
      else if (corruption === "maker") batch.settlement.makerIntents[0] = batch.settlement.takerIntents[0];
      else if (corruption === "aggregate") batch.settlement.aggregateVolume += 2n;
      else batch.settlement[corruption] += 1n;
      expect(walletTradedVolume(store, ALICE).amount).toBeNull();
    }
  });

  test("unrelated legacy corruption does not invalidate a complete wallet history", () => {
    const store = new ProtocolStore();
    const own = addBatch(store, "old-isolated-own", [intent("old-iso-own-long", UNIT), intent("old-iso-own-short", -UNIT, BOB)]);
    const foreign = addBatch(store, "old-isolated-foreign", [intent("old-iso-foreign-long", UNIT, BOB), intent("old-iso-foreign-short", -UNIT, CAROL)]);
    makeLegacy(store, [own, foreign]);
    store.privateMatchIntents.get(foreign.positions[0].sourceIntentCommitment)!.margin += 1n;
    expect(walletTradedVolume(store, ALICE).amount).toBe(2n * UNIT);
    expect(walletTradedVolume(store, CAROL).amount).toBeNull();
  });

  test("does not downgrade a modern payload when entropy is removed or mix historical formats", () => {
    for (const removed of ["ownerDigest", "both", "mixed"] as const) {
      const store = new ProtocolStore();
      const batch = addBatch(store, `downgrade-${removed}`, [intent(`down-long-${removed}`, UNIT), intent(`down-short-${removed}`, -UNIT, BOB)]);
      if (removed === "mixed") makeLegacy(store, [batch]);
      const payload = store.privateMatchIntents.get(batch.positions[0].sourceIntentCommitment)!;
      if (removed === "mixed") { payload.ownerDigest = digestToFieldHex("modern"); payload.positionSeed = digestToFieldHex("modern-seed"); }
      else { Reflect.deleteProperty(payload, "ownerDigest"); if (removed === "both") Reflect.deleteProperty(payload, "positionSeed"); }
      expect(walletTradedVolume(store, ALICE).amount).toBeNull();
    }
  });

  test("serializes only the authenticated owner's aggregate and rejects foreign portfolio reads", async () => {
    const store = new ProtocolStore();
    addBatch(store, "api", [intent("api-long", 3n * UNIT), intent("api-short", -3n * UNIT, BOB)]);
    const controller = new PortfolioController(new PortfolioService(new ExecutorService({}, store)));
    const own = new Request(`http://pnlx.local/portfolio?ownerCommitment=${ALICE}`);
    setAuthenticatedAddress(own, "GALICE");
    const response = controller.get(own);
    const payload = await response.json() as { portfolio: { tradedVolume: unknown } };
    expect(payload.portfolio.tradedVolume).toEqual({ amount: "60000000", status: "available", source: "pnlx-confirmed-fills" });
    expect(JSON.stringify(payload)).not.toContain('"signedSize"');
    expect(JSON.stringify(payload)).not.toContain('"ownerDigest"');
    const foreign = new Request(`http://pnlx.local/portfolio?ownerCommitment=${BOB}`);
    setAuthenticatedAddress(foreign, "GALICE");
    expect(() => controller.get(foreign)).toThrow("ownerCommitment does not match authenticated account");
  });
});
