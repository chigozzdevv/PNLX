import { expect, test } from "bun:test";
import { hashFields, ownerCommitment } from "@pnlx/crypto";
import type { BatchSettlement, Hex, PositionLifecycleRecord, PrivateMatchIntent } from "@pnlx/protocol-types";
import { makerPositionsReadyForReconciliation } from "../../scripts/operations/reconcile-maker-position";
import { ProtocolStore } from "@/shared/state/store";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";
import type { VaultMakerAllocation } from "@/shared/vault-maker-backing";

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
