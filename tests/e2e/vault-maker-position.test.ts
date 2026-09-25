import { expect, test } from "bun:test";
import { hashFields, ownerCommitment } from "@pnlx/crypto";
import type { BatchSettlement, Hex, PositionLifecycleRecord, PrivateMatchIntent } from "@pnlx/protocol-types";
import { makerPositionsReadyForReconciliation } from "../../scripts/operations/reconcile-maker-position";
import { preparePairedMakerClose, vaultMakerPairForTrader } from "@/features/position-closes/vault-maker-pair";
import { reconstructPositionOpening } from "@/features/account-keys/account-key-recovery";
import { settleClose } from "@pnlx/market-math";
import { ProtocolStore } from "@/shared/state/store";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";
import type { VaultMakerAllocation } from "@/shared/vault-maker-backing";
import { createProver } from "@/workers/prover/prover.worker";

const maker = "GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";
const vault = "CAU2RWJFKWZIRWLTO734X2BSVIAH22WHCIRRYIBLQPHIUPPFQ6U5MMTQ";
const asset = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const batchId = "maker-close-pair";

function matchedTrade() {
  const market = { marketId: "xlm-usd-perp", fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };
  const clientIntent = hashFields("client-intent", [1]);
  const makerIntent = hashFields("maker-intent", [1]);
  const intents: PrivateMatchIntent[] = [
    { batchId, intentCommitment: clientIntent, limitPrice: 100_000_000n,
      margin: 200_000_000n, marketId: market.marketId, noteChangeCommitment: "0x0",
      noteNullifier: hashFields("client-nullifier", [1]),
      ownerCommitment: hashFields("client-owner", [1]), signedSize: 1_000_000_000n },
    { batchId, intentCommitment: makerIntent, limitPrice: 100_000_000n,
      margin: 200_000_000n, marketId: market.marketId, noteChangeCommitment: "0x0",
      noteNullifier: hashFields("maker-nullifier", [1]),
      ownerCommitment: ownerCommitment(maker), signedSize: -1_000_000_000n },
  ];
  const match = new BatchMatcherService().match({ batchId, market, intents });
  const settlement = { ...prepareRisc0SettlementDraft({ batchId, market, intents, match }),
    proof: { circuitId: "batch-match", circuitHash: hashFields("test", [1]),
      verifierHash: hashFields("test", [2]), publicInputHash: hashFields("test", [3]),
      proofDigest: hashFields("test", [4]) } } as BatchSettlement;
  const store = new ProtocolStore();
  store.settlements.set(`${market.marketId}:${batchId}`, settlement);
  for (const commitment of settlement.newCommitments) store.positionCommitments.add(commitment);
  for (const intent of intents) store.privateMatchIntents.set(intent.intentCommitment, intent);
  for (const fill of match.fills) {
    store.positionLifecycle.set(fill.positionCommitment, {
      batchId, marketId: market.marketId, openedAt: 1,
      ownerCommitment: fill.ownerCommitment,
      positionCommitment: fill.positionCommitment,
      positionNullifier: fill.positionNullifier,
      settlementDigest: settlement.settlementDigest,
      sourceIntentCommitment: fill.intentCommitment,
      status: "open", updatedAt: 1,
    });
  }
  const client = [...store.positionLifecycle.values()].find((item) =>
    item.sourceIntentCommitment === clientIntent)!;
  const closeCommitment = hashFields("client-close", [1]);
  const closedClient = {
    ...client, status: "closed", closeCommitment, updatedAt: 2,
  } as PositionLifecycleRecord;
  store.positionLifecycle.set(client.positionCommitment, closedClient);
  store.positionCloses.set(closeCommitment, {
    marketId: market.marketId, markPrice: market.oraclePrice,
    positionCommitment: client.positionCommitment, positionNullifier: client.positionNullifier,
    positionRoot: hashFields("root", [1]), closeCommitment,
    newPositionCommitment: hashFields("new-position", [1]),
    marginOutputCommitment: hashFields("output", [1]),
    proof: settlement.proof, settlementTxHash: hashFields("close-tx", [1]),
  });
  const allocation: VaultMakerAllocation = { id: `${vault}:${"a".repeat(64)}`,
    allocationLedger: 1, allocationTxHash: "a".repeat(64), amount: "1000000000",
    asset, maker, noteCommitments: [hashFields("maker-note", [1])],
    registeredAmount: "1000000000", series: 1, status: "outstanding", vault };
  const note = { amount: "1000000000", assetDigest: hashFields("asset", [1]),
    commitment: allocation.noteCommitments[0] as Hex,
    lockedByIntentCommitment: makerIntent, status: "spent", token: asset,
    vaultAllocationId: allocation.id, walletAddress: maker };
  return { allocation, client: closedClient, note, store };
}

test("a confirmed client close selects only its paired vault maker fill and original principal", () => {
  const { allocation, client, note, store } = matchedTrade();
  const hash = store.positionCloses.get(client.closeCommitment!)!.proof.circuitHash;
  const candidates = makerPositionsReadyForReconciliation(store, [note], [allocation], maker, hash);
  expect(candidates).toHaveLength(1);
  expect(candidates[0].clientPosition.positionCommitment).toBe(client.positionCommitment);
  expect(candidates[0].principal).toBe(200_000_000n);
  expect(makerPositionsReadyForReconciliation(store, [note], [allocation], maker)).toHaveLength(1);
  store.positionLifecycle.set(client.positionCommitment, { ...client, status: "open" });
  expect(makerPositionsReadyForReconciliation(store, [note], [allocation], maker, hash)).toEqual([]);
  store.positionLifecycle.set(client.positionCommitment, client);
  expect(makerPositionsReadyForReconciliation(store, [note],
    [{ ...allocation, status: "closed" }], maker, hash)).toEqual([]);
  expect(makerPositionsReadyForReconciliation(store, [note], [allocation], maker,
    hashFields("old-close-circuit", [1]))).toEqual([]);
});

test("an open trader selects the exact vault-backed maker and their price PnL offsets", () => {
  const { allocation, client, note, store } = matchedTrade();
  const openClient = { ...client, status: "open" as const, closeCommitment: undefined };
  store.positionLifecycle.set(client.positionCommitment, openClient);
  const pair = vaultMakerPairForTrader({
    allocations: [allocation], asset, maker, notes: [note], store,
    trader: openClient, vault,
  });
  expect(pair?.makerNote.commitment).toBe(note.commitment);
  expect(pair?.principal).toBe(200_000_000n);
  const traderOpening = reconstructPositionOpening(store, openClient)!;
  const makerOpening = reconstructPositionOpening(store, pair!.makerPosition)!;
  const closeMark = 99_000_000n;
  const traderResult = settleClose({
    side: traderOpening.side, closeSize: traderOpening.size,
    entryPrice: traderOpening.entryPrice, markPrice: closeMark,
    margin: traderOpening.margin, fundingPayment: 0n, fee: 0n,
  });
  const makerResult = settleClose({
    side: makerOpening.side, closeSize: makerOpening.size,
    entryPrice: makerOpening.entryPrice, markPrice: closeMark,
    margin: makerOpening.margin, fundingPayment: 0n, fee: 0n,
  });
  expect(traderResult.realizedPnl).toBe(-makerResult.realizedPnl);
  expect(traderResult.realizedPnl).toBeLessThan(0n);
  expect(makerResult.realizedPnl).toBeGreaterThan(0n);
  expect(() => vaultMakerPairForTrader({
    allocations: [allocation], asset, maker, notes: [{ ...note, status: "available" }],
    store, trader: openClient, vault,
  })).toThrow("paired vault maker note is unavailable");
});

test("maker close proof uses the trader's mark and produces a recoverable note", () => {
  const { allocation, client, note, store } = matchedTrade();
  const openClient = { ...client, status: "open" as const, closeCommitment: undefined };
  store.positionLifecycle.set(client.positionCommitment, openClient);
  const pair = vaultMakerPairForTrader({
    allocations: [allocation], asset, maker, notes: [note], store,
    trader: openClient, vault,
  })!;
  const prepared = preparePairedMakerClose({
    fundingIndex: 0n, makerNote: pair.makerNote,
    makerPosition: pair.makerPosition, markPrice: 99_000_000n,
    prover: createProver(), store, traderCloseCommitment: hashFields("trader-close", [1]),
  });
  expect(prepared.close.markPrice).toBe(99_000_000n);
  expect(prepared.note.amount).toBe("209500000");
  expect(prepared.note.commitment).toBe(prepared.close.marginOutputCommitment);
  expect(prepared.note.closePositionCommitment).toBe(pair.makerPosition.positionCommitment);
});

test("paired close records both lifecycle changes and output indices together", () => {
  const { client, store } = matchedTrade();
  store.positionCloses.delete(client.closeCommitment!);
  store.positionLifecycle.set(client.positionCommitment, {
    ...client, status: "open", closeCommitment: undefined,
  });
  const settlement = [...store.settlements.values()][0]!;
  const makerPosition = [...store.positionLifecycle.values()].find((position) =>
    position.ownerCommitment === ownerCommitment(maker))!;
  const traderClose = {
    marketId: client.marketId, markPrice: 99_000_000n,
    positionCommitment: client.positionCommitment,
    positionNullifier: client.positionNullifier,
    positionRoot: store.positionMembershipRoot(),
    closeCommitment: hashFields("trader-close", [2]),
    newPositionCommitment: hashFields("trader-new", [2]),
    marginOutputCommitment: hashFields("trader-output", [2]),
    proof: settlement.proof,
  };
  const makerClose = {
    ...traderClose,
    positionCommitment: makerPosition.positionCommitment,
    positionNullifier: makerPosition.positionNullifier,
    closeCommitment: hashFields("maker-close", [2]),
    newPositionCommitment: hashFields("maker-new", [2]),
    marginOutputCommitment: hashFields("maker-output", [2]),
  };
  store.recordProof(settlement.proof);
  const before = store.positionCommitments.size;
  store.addPairedPositionCloses(traderClose, makerClose, false);
  expect(store.positionLifecycle.get(client.positionCommitment)?.status).toBe("closed");
  expect(store.positionLifecycle.get(makerPosition.positionCommitment)?.status).toBe("closed");
  expect(store.positionCloses.get(traderClose.closeCommitment)?.outputPositionIndex).toBe(before);
  expect(store.positionCloses.get(makerClose.closeCommitment)?.outputPositionIndex).toBe(before + 1);
  expect(store.positionCommitments.size).toBe(before + 2);
});
