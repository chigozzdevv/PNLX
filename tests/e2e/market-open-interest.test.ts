import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFields } from "@pnlx/crypto";
import { PRICE_SCALE } from "@pnlx/market-math";
import type { BatchSettlement, Hex, IntentRecord, PositionCloseRecord, PositionLifecycleRecord, PrivateMatchIntent, ProofMeta } from "@pnlx/protocol-types";
import { assertSettlementExposure, marketOpenInterest } from "@/features/markets/market-open-interest";
import { FEE_CONFIG_HASH } from "@/shared/protocol/fee-config";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { ProtocolStore } from "@/shared/state/store";
import { snapshotProtocolStore } from "@/shared/state/protocol-snapshot";
import { normalizedSnapshotCounts, normalizedSnapshotFromRecords, normalizedSnapshotRecords } from "@/shared/mongo/snapshot";
import { ExecutorService } from "@/workers/executor/executor.service";
import { MatcherService } from "@/workers/matcher/matcher.service";
import { matchingPayloadCommitment } from "@/workers/batch-matcher/private-intent";
import { parseExternalBatchSettlement } from "@/features/batches/batches.schema";
import { RemoteMatcherClient } from "@/workers/matcher/remote/matcher.service";
import { json } from "@/shared/http/json";

const MARKET = "xlm-usd-perp";
const BASE = 10_000_000n;
const MARK = 2n * PRICE_SCALE;
const strict = { requireOnchainConfirmation: true };

describe("PNLX settled open interest", () => {
  test("reports a genuine empty confirmed history as zero", () => {
    expect(marketOpenInterest(new ProtocolStore(), MARKET, MARK, strict)).toMatchObject({
      status: "available", baseAmount: 0n, quoteAmount: 0n, positionCount: 0,
    });
  });

  test("counts both counterparties once, marks USD, and ignores the legacy delta field", () => {
    const store = new ProtocolStore();
    const { settlement } = addBatch(store, "open", [3n * BASE, 3n * BASE]);
    settlement.openInterestDelta = 99_999n * BASE;
    expect(marketOpenInterest(store, MARKET, MARK, strict)).toMatchObject({
      status: "available", grossBaseAmount: 6n * BASE, baseAmount: 3n * BASE,
      quoteAmount: 6n * BASE, convention: "half-gross-base",
    });
    expect(marketOpenInterest(store, MARKET, 3n * PRICE_SCALE, strict).quoteAmount).toBe(9n * BASE);
    expect(marketOpenInterest(store, "btc-usd-perp", MARK, strict).baseAmount).toBe(0n);
  });

  test("paired closes and terminal output commitments remove both legs exactly once", () => {
    const store = new ProtocolStore();
    const { positions } = addBatch(store, "pair-close", [4n * BASE, 4n * BASE]);
    const pair = positions.map(closeRecord) as [PositionCloseRecord, PositionCloseRecord];
    store.recordProof(pair[0].proof);
    store.addPairedPositionCloses(pair[0], pair[1], false);
    expect(marketOpenInterest(store, MARKET, MARK, strict).baseAmount).toBe(0n);
    expect(store.positionCommitments.size).toBe(4);
    expect(() => store.addPairedPositionCloses(pair[0], pair[1], false)).toThrow("already closed");
    expect(marketOpenInterest(store, MARKET, MARK, strict).baseAmount).toBe(0n);
  });

  test("standalone closes and liquidations remove their leg symmetrically", () => {
    for (const index of [0, 1]) {
      const store = new ProtocolStore();
      const { positions } = addBatch(store, `liquidate-${index}`, [4n * BASE, 4n * BASE]);
      const position = positions[index];
      const proof = proofMeta();
      store.recordProof(proof);
      store.addLiquidation({ marketId: MARKET, markPrice: MARK, currentFundingIndex: 0n,
        maintenanceRate: 100_000n, positionCommitment: position.positionCommitment,
        positionNullifier: position.positionNullifier, positionRoot: hex("root"), rewardCommitment: hex("reward"), proof });
      expect(marketOpenInterest(store, MARKET, MARK, strict).baseAmount).toBe(2n * BASE);
      const remaining = closeRecord(positions[1 - index]);
      store.recordProof(remaining.proof); store.addManualPositionClose(remaining);
      expect(marketOpenInterest(store, MARKET, MARK, strict).baseAmount).toBe(0n);
    }
  });

  test("private legacy two-leg batches reconstruct quantities without retained plaintext", () => {
    const store = new ProtocolStore();
    const { positions } = addBatch(store, "legacy-private", [6n * BASE, 6n * BASE], false);
    expect(store.privateMatchIntents.size).toBe(0);
    const close = closeRecord(positions[0]);
    store.recordProof(close.proof); store.addManualPositionClose(close);
    expect(marketOpenInterest(store, MARKET, MARK, strict)).toMatchObject({ status: "available", baseAmount: 3n * BASE });
  });

  test("legacy partial fills use residual quantities and paired outputs, not the original order size", () => {
    const store = new ProtocolStore();
    const { settlement, positions } = addBatch(store, "legacy-partial", [2n * BASE, 2n * BASE, 3n * BASE, 3n * BASE], false);
    const long = payload("large-long", 10n * BASE), residual = payload("residual-long", 5n * BASE);
    const shortA = payload("short-a", -2n * BASE), shortB = payload("short-b", -3n * BASE);
    for (const value of [long, residual, shortA, shortB]) store.privateMatchIntents.set(value.intentCommitment, value);
    positions[0].sourceIntentCommitment = long.intentCommitment;
    positions[2].sourceIntentCommitment = long.intentCommitment;
    positions[1].sourceIntentCommitment = shortA.intentCommitment;
    positions[3].sourceIntentCommitment = shortB.intentCommitment;
    settlement.orderUpdates = [
      { intentCommitment: long.intentCommitment, residualCommitment: residual.intentCommitment, status: "partially-filled" },
      { intentCommitment: shortA.intentCommitment, status: "filled" },
      { intentCommitment: shortB.intentCommitment, status: "filled" },
    ];
    const closes = positions.slice(0, 2).map(closeRecord) as [PositionCloseRecord, PositionCloseRecord];
    store.recordProof(closes[0].proof); store.addPairedPositionCloses(closes[0], closes[1], false);
    expect(marketOpenInterest(store, MARKET, MARK, strict)).toMatchObject({ status: "available", baseAmount: 3n * BASE });
  });

  test("unknown legacy mixed exits are incomplete while full-batch totals remain usable", () => {
    const store = new ProtocolStore();
    const { positions } = addBatch(store, "unknown-legacy", [2n * BASE, 2n * BASE, 3n * BASE, 3n * BASE], false);
    expect(marketOpenInterest(store, MARKET, MARK, strict).baseAmount).toBe(5n * BASE);
    const close = closeRecord(positions[0]);
    store.recordProof(close.proof); store.addManualPositionClose(close);
    expect(marketOpenInterest(store, MARKET, MARK, strict)).toMatchObject({ status: "incomplete", baseAmount: null, quoteAmount: null });
  });

  test("does not count provisional batches or treat unknown legacy confirmation as confirmed zero", () => {
    const store = new ProtocolStore();
    const { settlement } = addBatch(store, "pending", [BASE, BASE]);
    settlement.onchainConfirmed = false;
    expect(marketOpenInterest(store, MARKET, MARK, strict).baseAmount).toBe(0n);
    delete settlement.onchainConfirmed;
    expect(marketOpenInterest(store, MARKET, MARK, strict)).toMatchObject({ status: "incomplete", baseAmount: null });
    expect(marketOpenInterest(store, MARKET, MARK).baseAmount).toBe(BASE);
  });

  test("missing lifecycle, orphan exposure and unindexed contract commitments cannot silently become zero", () => {
    const store = new ProtocolStore();
    const { positions } = addBatch(store, "missing", [BASE, BASE]);
    store.positionLifecycle.delete(positions[0].positionCommitment);
    expect(marketOpenInterest(store, MARKET, MARK, strict)).toMatchObject({ status: "incomplete", baseAmount: null });
    const orphan = new ProtocolStore();
    orphan.positionLifecycle.set(positions[0].positionCommitment, positions[0]);
    expect(marketOpenInterest(orphan, MARKET, MARK, strict).baseAmount).toBeNull();
    const unknown = new ProtocolStore(); unknown.positionCommitments.add(hex("unknown-chain-position"));
    expect(marketOpenInterest(unknown, MARKET, MARK, strict).baseAmount).toBeNull();
  });

  test("duplicate settlement aliases and repeated reads are idempotent", () => {
    const store = new ProtocolStore();
    const { settlement } = addBatch(store, "replay", [BASE, BASE]);
    store.settlements.set("replayed-alias", { ...settlement });
    const first = marketOpenInterest(store, MARKET, MARK, strict);
    expect(first.baseAmount).toBe(BASE);
    expect(marketOpenInterest(store, MARKET, MARK, strict)).toEqual(first);
    store.settlements.set("conflict", { ...settlement, aggregateVolume: 4n * BASE });
    expect(marketOpenInterest(store, MARKET, MARK, strict).status).toBe("incomplete");
  });

  test("rejects inconsistent individual quantities before external accounting is committed", () => {
    const store = new ProtocolStore();
    const { settlement, positions } = addBatch(store, "forged", [BASE, BASE]);
    expect(() => assertSettlementExposure(settlement, positions, store.privateMatchIntents)).not.toThrow();
    expect(() => assertSettlementExposure(settlement, [{ ...positions[0], size: 2n * BASE }, positions[1]],
      store.privateMatchIntents)).toThrow("aggregate mismatch");
    expect(() => assertSettlementExposure(settlement, [{ ...positions[0], side: "short" }, positions[1]],
      store.privateMatchIntents)).toThrow("pair mismatch");
  });

  test("private exposure survives File and normalized Mongo snapshot codecs", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pnlx-oi-")), "store.json");
    const store = new FileProtocolStore(path);
    const { positions } = addBatch(store, "persist", [BASE, BASE]);
    const loaded = new FileProtocolStore(path);
    expect(loaded.positionLifecycle.get(positions[0].positionCommitment)).toMatchObject({ size: BASE, side: "long" });
    expect(marketOpenInterest(loaded, MARKET, MARK, strict).baseAmount).toBe(BASE);
    const snapshot = snapshotProtocolStore(store);
    const counts = normalizedSnapshotCounts(snapshotProtocolStore(new ProtocolStore()));
    counts.positionLifecycle = snapshot.positionLifecycle.length;
    const records = normalizedSnapshotRecords("testnet", "oi-snapshot", 1, "positionLifecycle", snapshot.positionLifecycle);
    expect(normalizedSnapshotFromRecords({ positionLifecycle: records }, counts).positionLifecycle).toEqual(snapshot.positionLifecycle);
  });

  test("local and external private matching retain actual fill quantities through partial fills", async () => {
    for (const external of [false, true]) {
      const store = new ProtocolStore();
      store.addMarket({ marketId: MARKET, oraclePrice: MARK, maxLeverage: 10n, initialMarginRate: 100_000n,
        maintenanceMarginRate: 50_000n, fundingIndex: -9n });
      const long = payload(`creator-long-${external}`, 3n * BASE), short = payload(`creator-short-${external}`, -BASE);
      for (const source of [long, short]) {
        const record = { ...intentRecord(source), marginRoot: store.marginMembershipRoot() };
        store.recordProof(record.proof); store.addIntent(record, source);
      }
      const executor = new ExecutorService({}, store);
      if (external) {
        const matcher = new MatcherService(store, undefined, { accountEventEncryptor: () => "test-encrypted-opening" });
        const transcript = await matcher.createSettlementTranscript({ marketId: MARKET, batchId: "oi-creator" });
        transcript.settlement.onchainConfirmed = true;
        expect(transcript.positionOpenings.map((position) => position.size)).toEqual([BASE, BASE]);
        executor.commitExternalBatchSettlement(transcript, { proofVerified: true });
      } else {
        const settlement = executor.createBatchSettlement({ marketId: MARKET, batchId: "oi-creator" });
        settlement.onchainConfirmed = true; executor.commitBatchSettlement(settlement);
      }
      expect([...store.positionLifecycle.values()].map((position) => position.size)).toEqual([BASE, BASE]);
      expect([...store.positionLifecycle.values()].map((position) => position.fundingIndex)).toEqual([-9n, -9n]);
      store.privateMatchIntents.clear();
      expect(marketOpenInterest(store, MARKET, MARK, strict).baseAmount).toBe(BASE);
    }
  });

  test("remote matcher JSON responses retain exposure through parse, commit and a partial batch exit", async () => {
    const store = new ProtocolStore();
    store.addMarket({ marketId: MARKET, oraclePrice: MARK, maxLeverage: 10n, initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n, fundingIndex: -123_456n });
    for (const source of [payload("remote-long", 3n * BASE), payload("remote-short-a", -BASE), payload("remote-short-b", -2n * BASE)]) {
      const record = { ...intentRecord(source), marginRoot: store.marginMembershipRoot() };
      store.recordProof(record.proof); store.addIntent(record, source);
    }
    const matcher = new MatcherService(store, undefined, { accountEventEncryptor: () => "test-encrypted-remote-opening" });
    const transcript = await matcher.createSettlementTranscript({ marketId: MARKET, batchId: "oi-creator" });
    const expectedExposure = transcript.positionOpenings.map(({ size, side, fundingIndex }) => ({ size, side, fundingIndex }));
    const respond = Object.assign(async () =>
      json({ jobId: "oi-remote-job", status: "completed", transcript }),
    { preconnect: globalThis.fetch.preconnect });
    const fetch = spyOn(globalThis, "fetch").mockImplementation(respond);
    try {
      const remote = new RemoteMatcherClient({ url: "https://matcher.test" });
      const parsed = await remote.createSettlementTranscript({ marketId: MARKET, batchId: "oi-creator" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(parsed.positionOpenings.map(({ size, side, fundingIndex }) => ({ size, side, fundingIndex }))).toEqual(expectedExposure);
      expect(parsed.positionOpenings).toHaveLength(4);
      parsed.settlement.onchainConfirmed = true;
      new ExecutorService({}, store).commitExternalBatchSettlement(parsed, { proofVerified: true });
      expect([...store.positionLifecycle.values()].every((position) => position.fundingIndex === -123_456n)).toBe(true);
      store.privateMatchIntents.clear();
      const pair = parsed.settlement.newCommitments.slice(0, 2)
        .map((commitment) => closeRecord(store.positionLifecycle.get(commitment)!)) as [PositionCloseRecord, PositionCloseRecord];
      store.recordProof(pair[0].proof); store.addPairedPositionCloses(pair[0], pair[1], false);
      expect(marketOpenInterest(store, MARKET, MARK, strict)).toMatchObject({ status: "available", baseAmount: 2n * BASE });
    } finally { fetch.mockRestore(); }
  });

  test("HTTP parsing keeps legacy absent exposure optional and rejects malformed or partial fields", () => {
    const { settlement, positions } = addBatch(new ProtocolStore(), "schema", [BASE, BASE]);
    const wire = JSON.parse(JSON.stringify({ settlement, positionOpenings: positions, accountEvents: [] },
      (_key, value) => typeof value === "bigint" ? value.toString() : value));
    for (const opening of wire.positionOpenings) { delete opening.size; delete opening.side; }
    const legacy = parseExternalBatchSettlement(wire);
    expect(legacy.positionOpenings[0].size).toBeUndefined();
    expect(legacy.positionOpenings[0].side).toBeUndefined();
    expect(legacy.positionOpenings[0].fundingIndex).toBeUndefined();
    const parseWith = (exposure: Record<string, unknown>) => parseExternalBatchSettlement({
      ...wire, positionOpenings: [{ ...wire.positionOpenings[0], ...exposure }, wire.positionOpenings[1]],
    });
    for (const size of ["0", "-1", "1.5", "0x10", "1e3", true, null, {}, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseWith({ size, side: "long" })).toThrow("positive integer");
    }
    expect(() => parseWith({ size: "1", side: "buy" })).toThrow("invalid position exposure side");
    expect(() => parseWith({ size: "1" })).toThrow("provided together");
    expect(() => parseWith({ side: "long" })).toThrow("provided together");
    expect(parseWith({ size: "9007199254740993", side: "short" }).positionOpenings[0])
      .toMatchObject({ size: 9_007_199_254_740_993n, side: "short" });
    for (const fundingIndex of ["1.5", "0x10", "1e3", true, null, {}, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseWith({ fundingIndex })).toThrow("funding index must be a signed integer");
    }
    expect(parseWith({ fundingIndex: "-9007199254740993" }).positionOpenings[0].fundingIndex).toBe(-9_007_199_254_740_993n);
    expect(parseWith({ fundingIndex: "0" }).positionOpenings[0].fundingIndex).toBe(0n);
  });
});

function addBatch(store: ProtocolStore, id: string, sizes: bigint[], exposure = true) {
  const proof = proofMeta();
  const positions: PositionLifecycleRecord[] = sizes.map((size, index) => ({
    batchId: id, marketId: MARKET, openedAt: 1, ownerCommitment: hex(`${id}-owner-${index}`),
    positionCommitment: hex(`${id}-position-${index}`), positionNullifier: hex(`${id}-nullifier-${index}`),
    settlementDigest: hex(`${id}-settlement`), sourceIntentCommitment: hex(`${id}-intent-${index}`),
    status: "open", updatedAt: 1, ...(exposure ? { size, side: index % 2 === 0 ? "long" as const : "short" as const } : {}),
  }));
  const settlement: BatchSettlement = {
    aggregateVolume: sizes.reduce((sum, size) => sum + size, 0n), batchId: id, fillCount: sizes.length,
    feeConfigHash: FEE_CONFIG_HASH, grossTakerFee: 0n, makerRebate: 0n, insuranceFee: 0n, treasuryFee: 0n,
    makerIntents: [], takerIntents: [], matchingPayloadCommitments: [], marginChangeCommitments: [], marketId: MARKET,
    matchTranscriptDigest: hex(`${id}-transcript`), newCommitments: positions.map((position) => position.positionCommitment),
    openInterestDelta: 0n, orderUpdates: [], proof, residualSize: 0n, residualCommitments: [], residualMargins: [],
    residualPayloadCommitments: [], settlementDigest: positions[0].settlementDigest, spentNullifiers: [], onchainConfirmed: true,
  };
  store.recordProof(proof); store.addSettlement(settlement, positions);
  return { settlement, positions: positions.map((position) => store.positionLifecycle.get(position.positionCommitment)!) };
}

function closeRecord(position: PositionLifecycleRecord): PositionCloseRecord {
  return { marketId: position.marketId, markPrice: MARK, currentFundingIndex: 0n, positionCommitment: position.positionCommitment,
    positionNullifier: position.positionNullifier, positionRoot: hex("close-root"), closeCommitment: hex(`${position.positionCommitment}-close`),
    newPositionCommitment: hex(`${position.positionCommitment}-terminal`), marginOutputCommitment: hex(`${position.positionCommitment}-margin`),
    proof: proofMeta() };
}

function payload(id: string, signedSize: bigint): PrivateMatchIntent {
  return { batchId: "oi-creator", intentCommitment: hex(`${id}-intent`), limitPrice: MARK, margin: (signedSize < 0n ? -signedSize : signedSize) * 2n,
    marketId: MARKET, noteChangeCommitment: "0x0", noteNullifier: hex(`${id}-nullifier`), ownerCommitment: hex(`${id}-owner`),
    ownerDigest: hex(`${id}-owner-digest`), positionSeed: hex(`${id}-seed`), signedSize };
}

function intentRecord(source: PrivateMatchIntent): IntentRecord {
  return { batchId: source.batchId, marketId: source.marketId, batchDigest: hex("batch"), marketDigest: hex("market"),
    marginRoot: hex("margin-root"), assetDigest: hex("asset"), currentBatch: 0n, ownerCommitmentField: hex("owner-field"),
    ownerCommitment: source.ownerCommitment, intentCommitment: source.intentCommitment, matchingPayloadCommitment: matchingPayloadCommitment(source),
    noteChangeCommitment: source.noteChangeCommitment, proof: proofMeta(), noteNullifier: source.noteNullifier };
}

function proofMeta(): ProofMeta {
  return { circuitHash: hex("circuit"), circuitId: "batch-match", circuitKey: hex("circuit-key"),
    proofDigest: hex("proof"), publicInputHash: hex("public-input"), verifierHash: hex("verifier") };
}

function hex(value: string): Hex { return hashFields("oi-test", [value]); }
