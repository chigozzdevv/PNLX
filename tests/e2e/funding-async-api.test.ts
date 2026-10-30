import { describe, expect, test } from "bun:test";
import { FIELD_PRIME, fieldHex, hashFields } from "@pnlx/crypto";
import type { FundingSettlementRecord, Hex } from "@pnlx/protocol-types";
import { OnchainRelayService } from "@/workers/onchain/onchain.service";
import { createProver } from "@/workers/prover/prover.worker";

const cycleId=fieldHex(7n), key=(value:string):Hex=>hashFields("funding-async-test",[value]);
const record:FundingSettlementRecord={cycleId,appliedAt:60_000,elapsedMs:60_000,intervalMs:60_000,
  marketId:"xlm-usd-perp",oldFundingIndex:-5n,newFundingIndex:3n,fundingDelta:8n,markPrice:100_000_000n,premiumRate:1_000n,
  proof:{circuitId:"funding-update",circuitKey:key("key"),circuitHash:key("circuit"),verifierHash:key("vk"),publicInputHash:key("public"),proofDigest:key("proof")}};
function fixture(){
  const reads:Array<{functionName:string;args?:string[]}>=[], events:string[]=[];
  let missing:string|undefined;
  const relay={
    async readAsync(request:{payload:{functionName:string;args?:string[]}}){reads.push(request.payload);
      if(request.payload.functionName===missing)throw new Error("missing contract function");
      return{stdout:JSON.stringify(request.payload.functionName!=="is_cycle_settled")};},
    async relayAsync(){events.push("verify");return{};},
    async relayJournaled(request:{payload:{args:string[]}},before:(value:{txHash:Hex;xdr:string})=>Promise<void>){
      expect(request.payload.args).toContain("--cycle_id");expect(request.payload.args).toContain(cycleId.slice(2));
      await before({txHash:key("transaction"),xdr:"signed-funding-xdr"});events.push("send");return{};},
  };
  const service=new OnchainRelayService(relay as never,{enabled:true,
    deployment:{contracts:{"funding-settlement":"funding","batch-settlement":"batch"},
      verifiers:{"funding-update-proof-verifier":"verifier"},network:"testnet",source:"test",sourceAddress:"GTEST"},
    resolveProofArtifact:()=>({proofPath:"/tmp/mock-funding-proof",publicInputsPath:"/tmp/mock-funding-inputs"})});
  return{service,reads,events,missing:(value:string)=>{missing=value;}};
}
describe("async funding relay API",()=>{
  test("requires all three upgrade markers and never falls back to the legacy tuple query for a new cycle",async()=>{
    const f=fixture();expect(await f.service.fundingActivationReadyAsync()).toBe(true);
    expect(new Set(f.reads.map((read)=>read.functionName))).toEqual(new Set(["requires_operator_auth","funding_cycle_bound","funding_epoch_bound"]));
    expect(await f.service.isFundingSettledAsync(record.marketId,-5n,3n,cycleId)).toBe(false);
    expect(f.reads.at(-1)).toMatchObject({functionName:"is_cycle_settled"});
    expect(f.reads.at(-1)?.args).toEqual(["--market_id",hashFields("market-id",[record.marketId]).slice(2),
      "--cycle_id",cycleId.slice(2),"--old_index","-5","--new_index","3"]);
  });
  test("missing upgrade protection prevents even proof verification and transaction preparation",async()=>{
    for(const marker of ["requires_operator_auth","funding_cycle_bound","funding_epoch_bound"]){
      const f=fixture();f.missing(marker);
      await expect(f.service.settleFundingAsync(record,async()=>{throw new Error("must not prepare");})).rejects.toThrow("protections require upgrade");
      expect(f.events).toEqual([]);
    }
  });
  test("uses the async journaled path and awaits durable preparation before send",async()=>{
    const f=fixture();await f.service.settleFundingAsync(record,async(prepared)=>{
      expect(prepared).toEqual({txHash:key("transaction"),xdr:"signed-funding-xdr"});f.events.push("persist");});
    expect(f.events).toEqual(["verify","persist","send"]);
    const g=fixture();await expect(g.service.settleFundingAsync(record,async()=>{throw new Error("write unavailable");})).rejects.toThrow("write unavailable");
    expect(g.events).toEqual(["verify"]);
  });
  test("rejects noncanonical cycle aliases before proving or relaying",async()=>{
    const alias=`0x${(FIELD_PRIME+7n).toString(16).padStart(64,"0")}` as Hex;
    const f=fixture();await expect(f.service.settleFundingAsync({...record,cycleId:alias},async()=>{})).rejects.toThrow("canonical funding cycle");
    expect(f.reads).toEqual([]);expect(f.events).toEqual([]);
    const prover=createProver();const input={...record,cycleId:alias};
    expect(()=>prover.proveFundingSettlement(input)).toThrow("cycle id");
    await expect(prover.proveFundingSettlementAsync(input)).rejects.toThrow("cycle id");
  });
});
