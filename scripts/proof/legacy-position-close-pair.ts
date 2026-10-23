import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  circuitPositionCommitment, circuitPositionNullifier, digestToFieldHex, fieldHashPair,
  fieldHex, hashFields, mod, positionMerkleProof, secureMarginCommitment,
  type CircuitPositionNoteInput,
} from "../../packages/crypto/src/index";
import { buildProofArtifactAsync, type ProofArtifact, type ProverInput } from "../../packages/proof-system/src/artifact";
import { loadCircuit } from "../../packages/proof-system/src/circuits";
import { bindProof } from "../../packages/proof-system/src/proof";
import type { Hex, PairedPositionCloseRecord } from "../../packages/protocol-types/src/index";

export const LEGACY_PAIR_CIRCUIT = "legacy-position-close-pair" as const;
export interface LegacyCloseWitness extends CircuitPositionNoteInput {
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  positionRoot: Hex;
  markPrice: bigint;
  currentFundingIndex: bigint;
  closeCommitment: Hex;
  newPositionRhoDigest: Hex;
  newPositionBlinding: Hex;
  newPositionCommitment: Hex;
  marginOutputAmount: bigint;
  marginOutputCommitment: Hex;
  marginOutputAssetDigest: Hex;
  marginOutputRhoDigest: Hex;
  marginOutputBlinding: Hex;
  marginOutputSpendSecretDigest: Hex;
  pathSiblings: Hex[];
  pathIndices: boolean[];
}
export function legacyPositionCommitment(input: CircuitPositionNoteInput): Hex {
  const left = fieldHashPair(fieldHashPair(input.marketDigest,input.side === "long" ? 1n : 2n),
    fieldHashPair(input.size,input.entryPrice));
  const right = fieldHashPair(fieldHashPair(input.margin,input.fundingIndex),
    fieldHashPair(input.ownerDigest,fieldHashPair(input.rhoDigest,input.blinding)));
  return fieldHashPair(left,right);
}
const parts = (value:bigint) => ({abs:value < 0n ? -value : value,isNegative:value < 0n});
export function legacyPairProofPlan(inputs:[LegacyCloseWitness,LegacyCloseWitness],maintenanceRate:bigint) {
  const [first,second]=inputs;
  const assert=(condition:unknown) => { if(!condition)throw new Error("invalid funded legacy pair witness"); };
  assert(first.marketId===second.marketId && first.marketDigest===second.marketDigest &&
    first.marketDigest===digestToFieldHex(`market:${first.marketId}`) && first.side!==second.side &&
    first.size===second.size && first.entryPrice===second.entryPrice && first.fundingIndex===second.fundingIndex &&
    first.markPrice===second.markPrice && first.currentFundingIndex===second.currentFundingIndex &&
    first.positionRoot===second.positionRoot && first.marginOutputAssetDigest===second.marginOutputAssetDigest);
  assert(first.size>0n && first.entryPrice>0n && first.markPrice>0n && maintenanceRate>0n && maintenanceRate<=1_000_000n);
  const market=fieldHex(BigInt(hashFields("market-id",[first.marketId])));
  const collateral=first.margin+second.margin;
  for(const key of ["positionCommitment","positionNullifier","closeCommitment","newPositionCommitment","marginOutputCommitment"] as const)
    assert(first[key]!==second[key]);
  for(const input of inputs) {
    assert(input.margin>=0n && legacyPositionCommitment(input)===input.positionCommitment &&
      circuitPositionNullifier(input)===input.positionNullifier && input.pathSiblings.length===20 && input.pathIndices.length===20);
    let node=input.positionCommitment;
    for(let i=0;i<20;i++) node=input.pathIndices[i] ? fieldHashPair(input.pathSiblings[i],node) : fieldHashPair(node,input.pathSiblings[i]);
    assert(node===input.positionRoot);
    const sign=input.side==="long" ? 1n : -1n;
    const equity=input.margin+input.size*(input.markPrice-input.entryPrice)/100_000_000n*sign-
      input.size*(input.currentFundingIndex-input.fundingIndex)/100_000_000n*sign;
    const payout=equity<0n ? 0n : equity>collateral ? collateral : equity;
    assert(payout===input.marginOutputAmount);
    assert(circuitPositionCommitment({...input,marketDigest:market,size:0n,margin:0n,
      rhoDigest:input.newPositionRhoDigest,blinding:input.newPositionBlinding})===input.newPositionCommitment);
    assert(secureMarginCommitment({amount:payout,assetDigest:input.marginOutputAssetDigest,ownerDigest:input.ownerDigest,
      rhoDigest:input.marginOutputRhoDigest,blinding:input.marginOutputBlinding,
      spendSecretDigest:input.marginOutputSpendSecretDigest})===input.marginOutputCommitment);
  }
  assert(first.marginOutputAmount+second.marginOutputAmount===collateral);
  const current=parts(first.currentFundingIndex),old=parts(first.fundingIndex);
  const input:ProverInput={market_digest:market,asset_digest:first.marginOutputAssetDigest,mark_price:first.markPrice,
    current_funding_index_abs:current.abs,current_funding_index_is_negative:current.isNegative,
    maintenance_rate:maintenanceRate,liquidation:false,position_root:first.positionRoot,
    position_commitments:inputs.map(i=>i.positionCommitment),position_nullifiers:inputs.map(i=>i.positionNullifier),
    close_commitments:inputs.map(i=>i.closeCommitment),new_position_commitments:inputs.map(i=>i.newPositionCommitment),
    margin_output_commitments:inputs.map(i=>i.marginOutputCommitment),legacy_market_digest:first.marketDigest,
    is_long:inputs.map(i=>i.side==="long"),size:first.size,entry_price:first.entryPrice,funding_index:mod(first.fundingIndex),
    funding_index_abs:old.abs,funding_index_is_negative:old.isNegative,margins:inputs.map(i=>i.margin),
    owner_digests:inputs.map(i=>i.ownerDigest),rhos:inputs.map(i=>i.rhoDigest),blindings:inputs.map(i=>i.blinding),
    spend_secret_digests:inputs.map(i=>i.spendSecretDigest),output_amounts:inputs.map(i=>i.marginOutputAmount),
    new_position_rhos:inputs.map(i=>i.newPositionRhoDigest),new_position_blindings:inputs.map(i=>i.newPositionBlinding),
    output_rhos:inputs.map(i=>i.marginOutputRhoDigest),output_blindings:inputs.map(i=>i.marginOutputBlinding),
    output_spend_secrets:inputs.map(i=>i.marginOutputSpendSecretDigest),path_siblings:inputs.map(i=>i.pathSiblings),
    path_indices:inputs.map(i=>i.pathIndices)};
  const publicFields=[market,first.marginOutputAssetDigest,first.markPrice,current.abs,current.isNegative,maintenanceRate,false,first.positionRoot,
    ...inputs.map(i=>i.positionCommitment),...inputs.map(i=>i.positionNullifier),...inputs.map(i=>i.closeCommitment),
    ...inputs.map(i=>i.newPositionCommitment),...inputs.map(i=>i.marginOutputCommitment)];
  const hash=createHash("sha256");
  for(const value of publicFields)hash.update(Buffer.from(mod(typeof value==="boolean" ? BigInt(value ? 1:0):BigInt(value)).toString(16).padStart(64,"0"),"hex"));
  return {input,publicInputHash:`0x${hash.digest("hex")}` as Hex,market};
}
export async function proveLegacyPair(root:string,inputs:[LegacyCloseWitness,LegacyCloseWitness],maintenanceRate:bigint):Promise<{pair:PairedPositionCloseRecord;artifact:ProofArtifact}> {
  const plan=legacyPairProofPlan(inputs,maintenanceRate);
  const artifact=await buildProofArtifactAsync(root,LEGACY_PAIR_CIRCUIT,{name:`legacy-pair-exit-${plan.publicInputHash.slice(2)}`,inputs:plan.input});
  if(artifact.publicInputsHash!==plan.publicInputHash)throw new Error("legacy exit public ABI mismatch");
  const proof={...bindProof(loadCircuit(root,LEGACY_PAIR_CIRCUIT),plan.publicInputHash,artifact),proofSystem:"noir-ultrahonk" as const};
  const [first]=inputs;
  const positions=inputs.map(input=>({marketId:input.marketId,markPrice:input.markPrice,currentFundingIndex:input.currentFundingIndex,
    positionRoot:input.positionRoot,positionCommitment:input.positionCommitment,positionNullifier:input.positionNullifier,
    closeCommitment:input.closeCommitment,newPositionCommitment:input.newPositionCommitment,
    marginOutputCommitment:input.marginOutputCommitment,proof})) as PairedPositionCloseRecord["positions"];
  return {artifact,pair:{marketId:first.marketId,markPrice:first.markPrice,assetDigest:first.marginOutputAssetDigest,
    currentFundingIndex:first.currentFundingIndex,maintenanceRate,liquidation:false,positionRoot:first.positionRoot,positions,proof}};
}
export function legacyPairFixture():[LegacyCloseWitness,LegacyCloseWitness] {
  const h=(v:number)=>fieldHex(BigInt(v));
  const inputs=[true,false].map((long,i)=>({marketId:"legacy-fixture-btc",marketDigest:digestToFieldHex("market:legacy-fixture-btc"),
    side:long?"long":"short",size:100_000_000n,entryPrice:100n,margin:20n,fundingIndex:-3n,
    ownerDigest:h(3+i*10),rhoDigest:h(4+i*10),blinding:h(5+i*10),spendSecretDigest:h(6+i*10),
    markPrice:150n,currentFundingIndex:2n,closeCommitment:h(23+i),newPositionRhoDigest:h(7+i*10),newPositionBlinding:h(8+i*10),
    marginOutputAmount:i===0?40n:0n,marginOutputAssetDigest:h(9),marginOutputRhoDigest:h(10+i*10),
    marginOutputBlinding:h(11+i*10),marginOutputSpendSecretDigest:h(12+i*10)}) as LegacyCloseWitness);
  for(const input of inputs) {
    input.positionCommitment=legacyPositionCommitment(input);input.positionNullifier=circuitPositionNullifier(input);
    input.newPositionCommitment=circuitPositionCommitment({...input,marketDigest:fieldHex(BigInt(hashFields("market-id",[input.marketId]))),size:0n,margin:0n,
      rhoDigest:input.newPositionRhoDigest,blinding:input.newPositionBlinding});
    input.marginOutputCommitment=secureMarginCommitment({amount:input.marginOutputAmount,assetDigest:input.marginOutputAssetDigest,
      ownerDigest:input.ownerDigest,rhoDigest:input.marginOutputRhoDigest,blinding:input.marginOutputBlinding,
      spendSecretDigest:input.marginOutputSpendSecretDigest});
  }
  for(const input of inputs) { const path=positionMerkleProof(inputs.map(i=>i.positionCommitment),input.positionCommitment);
    input.positionRoot=path.root;input.pathSiblings=path.siblings;input.pathIndices=path.indices; }
  return inputs as [LegacyCloseWitness,LegacyCloseWitness];
}
export const artifactHex=(path:string)=>readFileSync(path).toString("hex");
