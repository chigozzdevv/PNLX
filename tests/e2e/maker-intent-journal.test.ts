import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fieldHex,ownerCommitment,secureMarginCommitment,secureMarginNullifier} from "@pnlx/crypto";
import type {Hex,IntentRecord,PrivateMatchIntent} from "@pnlx/protocol-types";
import {FileProtocolStore} from "@/shared/state/persistent-store";
import {ExecutorService} from "@/workers/executor/executor.service";
import {ProverService} from "@/workers/prover/prover.service";
import {MakerLiquidityService} from "@/workers/maker-liquidity/maker-liquidity.service";
import {IntentsService} from "@/features/intents/intents.service";

test("maker admission survives registry acceptance before local commit without duplicate admission or cancellation resurrection",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"pnlx-maker-journal-"));
  try {
    const path=join(directory,"state.json");
    let store=new FileProtocolStore(path);let executor=new ExecutorService({},store);
    store.addMarket({marketId:"xlm-usd-perp",fundingIndex:0n,oraclePrice:100_000_000n,
      initialMarginRate:100_000n,maintenanceMarginRate:50_000n,maxLeverage:10n});
    const wallet="GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";
    const opening={amount:1_000_000_000n,assetDigest:fieldHex(2n),ownerDigest:fieldHex(3n),
      rhoDigest:fieldHex(4n),blinding:fieldHex(5n),spendSecretDigest:fieldHex(6n)};
    const note={...opening,amount:opening.amount.toString(),commitment:secureMarginCommitment(opening),
      noteNullifier:secureMarginNullifier(opening),ownerCommitment:ownerCommitment(wallet),
      status:"available",walletAddress:wallet};
    store.addMarginCommitment(note.commitment);
    const clientIntent={intentCommitment:fieldHex(10n),marketId:"xlm-usd-perp"} as IntentRecord;
    const payload={marketId:"xlm-usd-perp",signedSize:1_000_000_000n,margin:200_000_000n,
      limitPrice:100_000_000n} as PrivateMatchIntent;
    const input={batchId:"maker-journal-recovery",clientIntent,margin:200_000_000n,note,payload,
      size:1_000_000_000n,quotePrice:100_000_000n};
    const prover=new ProverService();let proofs=0;
    const original=prover.proveIntentValidityAsync.bind(prover);
    prover.proveIntentValidityAsync=async(witness)=>{proofs++;return original(witness);};
    let registered:IntentRecord|undefined;let admissions=0;let claims=0;let interrupted=true;let active=true;
    const onchain={enabled:true,
      secureNoteSnapshot:()=>({commitments:[note.commitment],root:store.marginMembershipRoot()}),
      isIntentRegisteredAsync:async()=>Boolean(registered),
      intentMatchingPayloadCommitmentAsync:async()=>{
        if(interrupted)throw new Error("simulated process loss after registry acceptance");
        return registered!.matchingPayloadCommitment;
      },
      isIntentActiveAsync:async()=>active,intentSubmissionSequenceAsync:async()=>7n,
      submitIntentAsync:async(record:IntentRecord)=>{
        const durable=new FileProtocolStore(path).pendingIntentSubmissions.get(record.intentCommitment);
        expect(durable?.prepared.privateMatchIntent.positionSeed).toBeDefined();
        admissions++;registered=record;
        throw new Error("registry response lost");
      },
    };
    const claim=async(_note:string,intent:string,source:string)=>{
      const durable=new FileProtocolStore(path).pendingIntentSubmissions;
      expect(durable.size).toBe(1);
      expect([...durable.values()][0]!.intentCommitment).toBe(intent as Hex);
      expect(source).toBe(clientIntent.intentCommitment);claims++;return true;
    };
    const maker=new MakerLiquidityService(executor,prover,onchain as never,
      {intentRegistryOnchainRequired:true},undefined,claim);
    const submit=(service:MakerLiquidityService)=>Reflect.get(service,"submitMakerIntent").call(service,input) as Promise<IntentRecord|undefined>;
    await expect(submit(maker)).rejects.toThrow("simulated process loss");
    expect(admissions).toBe(1);expect(claims).toBe(1);expect(store.intents.size).toBe(0);
    const pending=[...store.pendingIntentSubmissions.values()][0]!;
    const seed=pending.prepared.privateMatchIntent.positionSeed;
    store=new FileProtocolStore(path);executor=new ExecutorService({},store);interrupted=false;
    expect(store.pendingIntentSubmissions.size).toBe(1);
    const recovery=new IntentsService(executor,prover,onchain as never,{intentRegistryOnchainRequired:true});
    expect(await recovery.recoverPendingIntents()).toEqual({recovered:1,pending:0});
    expect(store.privateMatchIntents.get(registered!.intentCommitment)?.positionSeed).toBe(seed);
    expect(store.intents.get(registered!.intentCommitment)?.submissionSequence).toBe(7n);
    const restarted=new MakerLiquidityService(executor,prover,onchain as never,
      {intentRegistryOnchainRequired:true},undefined,claim);
    expect((await submit(restarted))?.intentCommitment).toBe(registered!.intentCommitment);
    expect(proofs).toBe(1);expect(admissions).toBe(1);expect(claims).toBe(1);
    store.cancelOrder(registered!.intentCommitment);active=false;
    expect(await submit(restarted)).toBeUndefined();
    expect(store.orderLifecycle.get(registered!.intentCommitment)?.status).toBe("cancelled");
    expect(proofs).toBe(1);expect(admissions).toBe(1);expect(claims).toBe(1);
  }finally{rmSync(directory,{recursive:true,force:true});}
},120_000);

test("a claimed unregistered maker journal resumes its exact order after restart only while its source remains open",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"pnlx-maker-pre-relay-"));
  try {
    const path=join(directory,"state.json");
    let store=new FileProtocolStore(path);let executor=new ExecutorService({},store);
    store.addMarket({marketId:"xlm-usd-perp",fundingIndex:0n,oraclePrice:100_000_000n,
      initialMarginRate:100_000n,maintenanceMarginRate:50_000n,maxLeverage:10n});
    const wallet="GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";
    const opening={amount:1_000_000_000n,assetDigest:fieldHex(2n),ownerDigest:fieldHex(3n),
      rhoDigest:fieldHex(4n),blinding:fieldHex(5n),spendSecretDigest:fieldHex(6n)};
    const note={...opening,amount:opening.amount.toString(),commitment:secureMarginCommitment(opening),
      noteNullifier:secureMarginNullifier(opening),ownerCommitment:ownerCommitment(wallet),
      status:"available",walletAddress:wallet};
    store.addMarginCommitment(note.commitment);
    const source=fieldHex(10n);
    const clientIntent={intentCommitment:source,marketId:"xlm-usd-perp"} as IntentRecord;
    const payload={marketId:"xlm-usd-perp",signedSize:1_000_000_000n,margin:200_000_000n,
      limitPrice:100_000_000n} as PrivateMatchIntent;
    store.intents.set(source,clientIntent);store.privateMatchIntents.set(source,payload);
    const lifecycle={intentCommitment:source,batchId:"source",marketId:"xlm-usd-perp",
      ownerCommitment:fieldHex(11n),status:"open" as const,createdAt:1,updatedAt:1};
    store.orderLifecycle.set(source,lifecycle);
    const prover=new ProverService();let proofs=0;let claims=0;let admissions=0;
    const original=prover.proveIntentValidityAsync.bind(prover);
    prover.proveIntentValidityAsync=async(witness)=>{proofs++;return original(witness);};
    let accepted:IntentRecord|undefined;let stopAfterClaim=true;let lockedBy:Hex|undefined;
    const onchain={enabled:true,
      secureNoteSnapshot:()=>({commitments:[note.commitment],root:store.marginMembershipRoot()}),
      isIntentRegisteredAsync:async(commitment:Hex)=>accepted?.intentCommitment===commitment,
      intentMatchingPayloadCommitmentAsync:async()=>accepted!.matchingPayloadCommitment,
      isIntentActiveAsync:async()=>true,intentSubmissionSequenceAsync:async()=>9n,
      submitIntentAsync:async(record:IntentRecord)=>{
        admissions++;accepted=record;throw new Error("accepted without response");
      },
    };
    const claim=async(commitment:string,intent:string,client:string)=>{
      expect(commitment).toBe(note.commitment);expect(client).toBe(source);
      expect(lockedBy===undefined||lockedBy===intent).toBe(true);
      claims++;lockedBy=intent as Hex;
      if(stopAfterClaim)throw new Error("process stopped after atomic claim");
      return true;
    };
    let maker=new MakerLiquidityService(executor,prover,onchain as never,{intentRegistryOnchainRequired:true},undefined,claim);
    await expect(Reflect.get(maker,"submitMakerIntent").call(maker,{batchId:"maker-pre-relay",clientIntent,
      margin:200_000_000n,note,payload,size:1_000_000_000n,quotePrice:100_000_000n})).rejects.toThrow("atomic claim");
    expect(admissions).toBe(0);expect(claims).toBe(1);expect(proofs).toBe(1);
    const before=[...store.pendingIntentSubmissions.values()][0]!;
    const seed=before.prepared.privateMatchIntent.positionSeed;
    store=new FileProtocolStore(path);executor=new ExecutorService({},store);stopAfterClaim=false;
    const recovered=new IntentsService(executor,prover,onchain as never,{intentRegistryOnchainRequired:true});
    expect(await recovered.recoverPendingIntents()).toEqual({recovered:0,pending:1});
    maker=new MakerLiquidityService(executor,prover,onchain as never,{intentRegistryOnchainRequired:true},undefined,claim);
    const locked=[{...note,status:"locked",lockedByIntentCommitment:lockedBy,sourceIntentCommitment:source}];
    const resume=()=>Reflect.get(maker,"resumePendingMakerIntents").call(maker,clientIntent,locked) as Promise<number>;
    for(const mismatch of [{walletAddress:"GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"},
      {sourceIntentCommitment:fieldHex(99n)},{vaultAllocationId:"unverified-vault-allocation"}]) {
      expect(await Reflect.get(maker,"resumePendingMakerIntents").call(maker,clientIntent,[{...locked[0],...mismatch}])).toBe(0);
    }
    expect(admissions).toBe(0);expect(claims).toBe(1);
    store.orderLifecycle.set(source,{...lifecycle,status:"cancelled"});
    expect(await resume()).toBe(0);expect(admissions).toBe(0);expect(claims).toBe(1);
    store.orderLifecycle.set(source,lifecycle);
    expect(await resume()).toBe(1);expect(admissions).toBe(1);expect(claims).toBe(2);
    expect(proofs).toBe(1);expect(store.pendingIntentSubmissions.size).toBe(0);
    expect(accepted?.intentCommitment).toBe(before.intentCommitment);
    expect(store.privateMatchIntents.get(before.intentCommitment)?.positionSeed).toBe(seed);
    expect(await resume()).toBe(0);expect(admissions).toBe(1);expect(claims).toBe(2);
  }finally{rmSync(directory,{recursive:true,force:true});}
},120_000);
