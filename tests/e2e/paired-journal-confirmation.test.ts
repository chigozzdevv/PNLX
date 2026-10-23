import {expect,test} from "bun:test";
import {fieldHex} from "@pnlx/crypto";
import type {Hex,PairedPositionCloseRecord} from "@pnlx/protocol-types";
import {ProtocolStore} from "@/shared/state/store";
import {PositionClosesService} from "@/features/position-closes/position-closes.service";
import type {PendingPairedClose} from "@/shared/protocol/paired-close-journal";

function pending() {
  const store=new ProtocolStore();
  const proof={circuitId:"position-close-pair",circuitKey:fieldHex(100n),circuitHash:fieldHex(1n),verifierHash:fieldHex(2n),
    publicInputHash:fieldHex(3n),proofDigest:fieldHex(4n)};
  const legs=[0,1].map(index=>({marketId:"fixture-btc-usd",markPrice:100n,currentFundingIndex:0n,
    positionRoot:fieldHex(5n),positionCommitment:fieldHex(BigInt(6+index)),positionNullifier:fieldHex(BigInt(8+index)),
    closeCommitment:fieldHex(BigInt(10+index)),newPositionCommitment:fieldHex(BigInt(12+index)),
    marginOutputCommitment:fieldHex(BigInt(14+index)),proof})) as PairedPositionCloseRecord["positions"];
  const run:PendingPairedClose={journalKey:legs[0].closeCommitment,pair:{marketId:"fixture-btc-usd",assetDigest:fieldHex(20n),
    markPrice:100n,currentFundingIndex:0n,maintenanceRate:100_000n,liquidation:false,positionRoot:fieldHex(5n),positions:legs,proof},
    outputNotes:[{},{}],conditional:false,createdAt:1,accountEvents:[undefined,undefined],
    settlementTxHash:fieldHex(30n),preparedXdr:"signed-envelope"};
  for(const leg of legs){
    store.positionCommitments.add(leg.positionCommitment);
    store.positionLifecycle.set(leg.positionCommitment,{batchId:"fixture",marketId:leg.marketId,
      ownerCommitment:fieldHex(40n),positionCommitment:leg.positionCommitment,positionNullifier:leg.positionNullifier,
      sourceIntentCommitment:fieldHex(41n),settlementDigest:fieldHex(42n),status:"open",openedAt:1,updatedAt:1});
  }
  store.addPendingPairedClose(run);
  return {store,run:store.pendingPairedCloses.get(run.journalKey)!};
}

test("settled contract flags do not substitute for a confirmed journaled transaction",async()=>{
  const {store,run}=pending(); let submitted=0;
  const onchain={enabled:true,isPositionCloseSettledAsync:async()=>true,positionPairTransactionStatus:async()=>"NOT_FOUND",
    settleJournaledPositionPair:async()=>{submitted++;}};
  const service=new PositionClosesService({store} as never,{} as never,onchain as never,{settlementsOnchainRequired:true});
  await expect(service.recoverPendingPairs()).rejects.toThrow("confirmation pending");
  expect(store.pendingPairedCloses.has(run.journalKey)).toBe(true);
  expect(store.positionCloses.size).toBe(0);
  expect(submitted).toBe(0);
});
test("stale public proof openings remain archived and a later public relay is reconciled without resubmission",async()=>{
  const {store,run}=pending();delete run.preparedXdr;delete run.settlementTxHash;
  run.outputNotes=[{spendSecretDigest:"retained-first-secret"},{spendSecretDigest:"retained-second-secret"}];
  store.markets.set(run.pair.marketId,{marketId:run.pair.marketId,fundingIndex:0n,oraclePrice:101n,
    initialMarginRate:100_000n,maintenanceMarginRate:100_000n,maxLeverage:10n});
  let settled=false;let submissions=0;const actualTx=fieldHex(99n);
  const onchain={enabled:true,isPositionCloseSettledAsync:async()=>settled,marketPriceAsync:async()=>101n,marketFundingIndexAsync:async()=>0n,
    positionPairTransactionStatus:async()=>"SUCCESS",positionCloseSettlementTransaction:async()=>actualTx,
    positionCloseAppendIndexAsync:async(close:Hex)=>close===run.pair.positions[0].closeCommitment?2:3,
    settleJournaledPositionPair:async()=>{submissions++;throw new Error("archived proof must not be submitted");}};
  const service=new PositionClosesService({store} as never,{} as never,onchain as never,{settlementsOnchainRequired:true});
  await expect(service.recoverPendingPairs()).rejects.toThrow("mark price mismatch");
  const archive=store.pendingPairedCloses.get(run.journalKey)!;
  expect(archive.retired).toBe(true);
  expect(archive.outputNotes[0].spendSecretDigest).toBe("retained-first-secret");
  await service.recoverPendingPairs();expect(submissions).toBe(0);
  settled=true;
  await service.recoverPendingPairs();
  const reconciled=store.pendingPairedCloses.get(run.journalKey)!;
  expect(reconciled.retiredReconciled).toBe(true);
  expect(reconciled.outputNotes[1].spendSecretDigest).toBe("retained-second-secret");
  expect(store.positionCloses.size).toBe(2);
  expect([...store.positionCloses.values()].every(close=>close.settlementTxHash===actualTx)).toBe(true);
  await service.recoverPendingPairs();expect(submissions).toBe(0);
});
test("a confirmed external append at a later index retains the journal without corrupting the local root",async()=>{
  const {store,run}=pending();
  const originalRoot=store.positionMembershipRoot();
  const onchain={enabled:true,isPositionCloseSettledAsync:async()=>true,positionPairTransactionStatus:async()=>"SUCCESS",
    positionCloseAppendIndexAsync:async(close:Hex)=>close===run.pair.positions[0].closeCommitment?4:5};
  const service=new PositionClosesService({store} as never,{} as never,onchain as never,{settlementsOnchainRequired:true});
  await expect(service.recoverPendingPairs()).rejects.toThrow("append order differs");
  expect(store.pendingPairedCloses.has(run.journalKey)).toBe(true);
  expect(store.positionCloses.size).toBe(0);
  expect(store.positionCommitments.size).toBe(2);
  expect(store.positionMembershipRoot()).toBe(originalRoot);
  expect(store.spentNullifiers.size).toBe(0);
});
test("an unknown transaction without its signed envelope is retained instead of being replaced",async()=>{
  const {store,run}=pending();delete run.preparedXdr;let submitted=0;
  const onchain={enabled:true,isPositionCloseSettledAsync:async()=>false,positionPairTransactionStatus:async()=>"NOT_FOUND",
    settleJournaledPositionPair:async()=>{submitted++;}};
  const service=new PositionClosesService({store} as never,{} as never,onchain as never,{settlementsOnchainRequired:true});
  await expect(service.recoverPendingPairs()).rejects.toThrow("signed recovery envelope");
  expect(store.pendingPairedCloses.has(run.journalKey)).toBe(true);
  expect(run.settlementTxHash).toBe(fieldHex(30n) as Hex);
  expect(submitted).toBe(0);
});
