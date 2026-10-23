import {createECDH} from "node:crypto";
import {describe,expect,test} from "bun:test";
import {digestToFieldHex,hashFields,ownerCommitment} from "@pnlx/crypto";
import type {Hex,PairedPositionCloseRecord,PositionCloseWitness,PrivateMatchIntent} from "@pnlx/protocol-types";
import {ProtocolStore} from "@/shared/state/store";
import {BatchMatcherService} from "@/workers/batch-matcher/batch-matcher.service";
import {prepareRisc0SettlementDraft} from "@/workers/risc0-matcher/risc0-proof";
import {hostedPositionCloseWitness,positionPayout} from "@/features/position-closes/paired-position-witness";
import {PositionClosesService} from "@/features/position-closes/position-closes.service";
import {ProtectionKeeperService,protectionDecision} from "@/workers/protection-keeper/protection-keeper.service";
import {createDelegatedConditionalPolicy} from "@/shared/protocol/delegated-policies";

const key=(label:string)=>digestToFieldHex(`protection-test:${label}`);
function fixture() {
  const store=new ProtocolStore();
  const market={marketId:"xlm-usd-perp",fundingIndex:0n,oraclePrice:100_000_000n,
    initialMarginRate:100_000n,maintenanceMarginRate:50_000n,maxLeverage:10n};
  store.markets.set(market.marketId,market);
  const owners=["GTRADER","GCOUNTERPARTY"];
  const intents:PrivateMatchIntent[]=[1n,-1n].map((side,index)=>({batchId:"protection",marketId:market.marketId,
    intentCommitment:key(`intent-${index}`),noteNullifier:key(`note-${index}`),ownerCommitment:ownerCommitment(owners[index]!),
    ownerDigest:key(`owner-${index}`),positionSeed:key(`secret-${index}`),noteChangeCommitment:"0x0",
    limitPrice:100_000_000n,margin:200_000_000n,signedSize:side*1_000_000_000n}));
  const match=new BatchMatcherService().match({batchId:"protection",market,intents});
  const draft=prepareRisc0SettlementDraft({batchId:"protection",market,intents,match});
  const proof={circuitId:"batch-match",circuitKey:key("batch-key"),circuitHash:key("source"),verifierHash:key("vk"),
    publicInputHash:key("inputs"),proofDigest:key("proof")};
  store.settlements.set(`${market.marketId}:protection`,{...draft,proof});
  for(const intent of intents) {
    store.privateMatchIntents.set(intent.intentCommitment,intent);
    store.intents.set(intent.intentCommitment,{...intent,assetDigest:key("asset")} as never);
    const ecdh=createECDH("prime256v1");ecdh.generateKeys();
    store.accountEncryptionKeys.set(intent.ownerCommitment,{ownerCommitment:intent.ownerCommitment,
      algorithm:"ecdh-p256-aes-gcm",
      publicKey:ecdh.getPublicKey().toString("base64url"),createdAt:1,updatedAt:1});
  }
  for(const fill of match.fills){
    store.positionCommitments.add(fill.positionCommitment);
    store.positionLifecycle.set(fill.positionCommitment,{batchId:"protection",marketId:market.marketId,
      openedAt:1,updatedAt:1,status:"open",ownerCommitment:fill.ownerCommitment,
      positionCommitment:fill.positionCommitment,positionNullifier:fill.positionNullifier,
      settlementDigest:draft.settlementDigest,sourceIntentCommitment:fill.intentCommitment});
  }
  const position=[...store.positionLifecycle.values()].find((item)=>item.ownerCommitment===intents[0]!.ownerCommitment)!;
  return {store,market,position,owners,intents};
}

describe("paired collateral and offline position protection",()=>{
  test("a price gap caps payouts and still conserves the two funded margins",()=>{
    const {store,position}=fixture();
    const other=[...store.positionLifecycle.values()].find((item)=>item!==position)!;
    const payout=positionPayout(store,position,200_000_000n,0n);
    const opposite=positionPayout(store,other,200_000_000n,0n);
    expect(payout).toBe(399_650_000n);
    expect(opposite).toBe(0n);
    expect(payout+opposite).toBe(399_650_000n);
  });

  test("funding direction and zero equity trigger liquidation before a stop",()=>{
    const input={side:"long" as const,size:100_000_000n,entryPrice:100n,margin:20n,
      fundingIndex:-3n,currentFundingIndex:2n,markPrice:100n,maintenanceRate:100_000n,stopLossPrice:101n};
    expect(protectionDecision(input)).toBe("stop-loss");
    expect(protectionDecision({...input,currentFundingIndex:17n})).toBe("liquidation");
    expect(protectionDecision({...input,side:"short",stopLossPrice:99n})).toBe("stop-loss");
    expect(protectionDecision({...input,stopLossPrice:90n,takeProfitPrice:100n})).toBe("take-profit");
  });

  test("a saved policy registers and executes without a browser or a prebuilt close proof",async()=>{
    const {store,position,intents}=fixture();
    store.markets.get(position.marketId)!.oraclePrice=95_000_000n;
    store.addDelegatedConditionalPolicy(createDelegatedConditionalPolicy({stopLossPrice:"98000000",stopLossSalt:"private-salt"},{
      intentCommitment:position.sourceIntentCommitment,marketId:position.marketId,ownerCommitment:position.ownerCommitment})!);
    const registrations:unknown[]=[];const closes:unknown[]=[];
    const keeper=new ProtectionKeeperService({store} as never,{
      recoverPendingPairs:async()=>{},closeHosted:async(...args:unknown[])=>{closes.push(args);},
    } as never,{
      registerAsync:async(record:unknown)=>registrations.push(record),
      triggerAsync:async()=>({closeCommitment:key("trigger")}),
    } as never);
    await keeper.runOnce();
    expect(registrations).toHaveLength(1);
    expect(closes).toHaveLength(1);
    expect((closes[0] as unknown[])[0]).toBe(position);
    expect(keeper.status.failures).toBe(0);
    expect(intents).toHaveLength(2);
  });

  test("a lost chain response recovers both legs and encrypted refunds without resubmission",async()=>{
    const {store,position,owners}=fixture();
    let flushes=0;let submissions=0;const settled=new Set<Hex>();
    Object.assign(store,{flush:async()=>{flushes++;}});
    const prover={provePositionClosePair:(inputs:[PositionCloseWitness,PositionCloseWitness],maintenanceRate:bigint,liquidation:boolean):PairedPositionCloseRecord=>{
      const proof={circuitId:"position-close-pair",circuitKey:key("pair-key"),circuitHash:key("pair-source"),verifierHash:key("pair-vk"),
        publicInputHash:key("pair-inputs"),proofDigest:key("pair-proof")};
      return {marketId:inputs[0].marketId,assetDigest:inputs[0].marginOutputAssetDigest,
        markPrice:inputs[0].markPrice,currentFundingIndex:inputs[0].currentFundingIndex,maintenanceRate,liquidation,
        positionRoot:inputs[0].positionRoot,proof,positions:inputs.map((input)=>({marketId:input.marketId,
          markPrice:input.markPrice,currentFundingIndex:input.currentFundingIndex,positionRoot:input.positionRoot,
          positionCommitment:input.positionCommitment,positionNullifier:input.positionNullifier,
          closeCommitment:input.closeCommitment,newPositionCommitment:input.newPositionCommitment,
          marginOutputCommitment:input.marginOutputCommitment,proof})) as PairedPositionCloseRecord["positions"]};
    }};
    const onchain={enabled:true,marketPriceAsync:async()=>100_000_000n,marketFundingIndexAsync:async()=>0n,
      isPositionCloseSettledAsync:async(close:Hex)=>settled.has(close),
      positionCloseAppendIndexAsync:async(close:Hex)=>2+[...settled].indexOf(close),
      positionPairTransactionStatus:async()=>settled.size?"SUCCESS":"NOT_FOUND",
      settleJournaledPositionPair:async(pair:PairedPositionCloseRecord,_conditional:boolean,
        beforeSubmit:(prepared:{txHash:Hex;xdr:string})=>Promise<void>)=>{
        await beforeSubmit({txHash:key("transaction"),xdr:"prepared-test-envelope"});
        expect(flushes).toBeGreaterThan(0);expect(store.pendingPairedCloses.size).toBe(1);
        submissions++;for(const leg of pair.positions)settled.add(leg.closeCommitment);
        throw new Error("response lost after atomic settlement");
      }};
    let asyncProofCalls = 0;
    const asyncProver = {
      provePositionClosePair: () => { throw new Error("synchronous pair proving must not run"); },
      async provePositionClosePairAsync(...args: Parameters<typeof prover.provePositionClosePair>) {
        asyncProofCalls += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return prover.provePositionClosePair(...args);
      },
    };
    const service=new PositionClosesService({store} as never,asyncProver as never,onchain as never,{settlementsOnchainRequired:true});
    const witness=hostedPositionCloseWitness({store,position,assetDigest:key("asset"),
      markPrice:100_000_000n,currentFundingIndex:0n,closeCommitment:key("manual")}).witness;
    await expect(service.createManualPaired(witness,owners[0])).rejects.toThrow("response lost");
    expect(store.pendingPairedCloses.size).toBe(1);
    await service.recoverPendingPairs();
    expect(submissions).toBe(1);expect(store.positionCloses.size).toBe(2);
    expect(store.accountEvents.size).toBe(2);expect(store.pendingPairedCloses.size).toBe(1);
    expect([...store.pendingPairedCloses.values()][0]?.retiredReconciled).toBe(true);
    expect([...store.positionLifecycle.values()].every((item)=>item.status==="closed")).toBe(true);
    await service.recoverPendingPairs();expect(submissions).toBe(1);
    expect(asyncProofCalls).toBe(1);
  });
});
