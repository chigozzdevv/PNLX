import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  circuitConditionalOrderCommitment, circuitIntentCommitment, circuitMatchingPayloadCommitment,
  circuitPositionCommitment, circuitPositionNullifier, derivePositionSeed,
  fieldHex, hashFields, mod, positionMerkleProof, secureMarginCommitment,
  secureMarginNullifier, secureMarginProof,
} from "@pnlx/crypto";
import { buildProofArtifact, loadCircuit, type CircuitId, type ProverInput, type ProverValue } from "@pnlx/proof-system";
import type { Hex, Side } from "@pnlx/protocol-types";

// Public, deterministic test values. Never use this fixture material for deposits.
const root = process.cwd();
const h = (value: number) => fieldHex(BigInt(value));
const market = fieldHex(BigInt(hashFields("market-id", ["fixture-btc-usd"])));
const asset = h(9);
const priceScale = 100_000_000n;
type Fixture = { id: CircuitId; inputs: ProverInput; publicFields: ProverValue[] };
const fixtures: Fixture[] = [];

function position(side: Side, margin: bigint, owner: number, rho: number, blinding: number, secret: number,
  size = priceScale, entryPrice = 100n, fundingIndex = -3n) {
  const opening = {side, margin, size, entryPrice, fundingIndex, marketDigest: market,
    ownerDigest: h(owner), rhoDigest: h(rho), blinding: h(blinding), spendSecretDigest: h(secret)};
  return {...opening, commitment: circuitPositionCommitment(opening),
    nullifier: circuitPositionNullifier(opening)};
}
function serialize(value: ProverValue): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(", ")}]`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}
function inputHash(values: ProverValue[]): Hex {
  const hash = createHash("sha256");
  const append = (value:ProverValue):void => {
    if(Array.isArray(value)){for(const item of value)append(item);return;}
    const numeric = typeof value === "boolean" ? BigInt(value ? 1 : 0) : BigInt(value);
    hash.update(Buffer.from(mod(numeric).toString(16).padStart(64,"0"), "hex"));
  };
  for(const value of values)append(value);
  return `0x${hash.digest("hex")}`;
}

const source = position("long", 1000n, 3, 4, 5, 6);
const membership = positionMerkleProof([source.commitment], source.commitment);
const newPosition = circuitPositionCommitment({...source, size: 0n, margin: 0n, rhoDigest: h(7), blinding: h(8)});
const output = secureMarginCommitment({amount: 1005n, assetDigest: asset, ownerDigest: source.ownerDigest,
  rhoDigest: h(10), blinding: h(11), spendSecretDigest: h(12)});
const closeInputs: ProverInput = {
  is_long: true, size: priceScale, close_size: priceScale, entry_price: 100n, mark_price: 110n,
  margin: 1000n, funding_index: fieldHex(-3n), funding_index_abs: 3n, funding_index_is_negative: true,
  current_funding_index_abs: 2n, current_funding_index_is_negative: false,
  funding_payment_abs: 5n, funding_is_credit: false, fee: 0n, new_margin: 1005n,
  remaining_margin: 0n, margin_output_amount: 1005n, price_scale: priceScale,
  position_root: membership.root, position_commitment_public: source.commitment,
  position_nullifier: source.nullifier, close_commitment: h(13),
  new_position_commitment: newPosition, margin_output_commitment: output,
  market_digest: market, owner_digest: source.ownerDigest, rho_digest: source.rhoDigest,
  blinding: source.blinding, spend_secret_digest: source.spendSecretDigest,
  new_position_rho_digest: h(7), new_position_blinding: h(8), margin_output_asset_digest: asset,
  margin_output_rho_digest: h(10), margin_output_blinding: h(11), margin_output_spend_secret_digest: h(12),
  path_siblings: membership.siblings, path_indices: membership.indices, zero_value: 0n,
};
fixtures.push({id: "position-close", inputs: closeInputs, publicFields: [110n,priceScale,membership.root,
  source.commitment,source.nullifier,h(13),newPosition,output,market,2n,false]});

const bankrupt = position("long", 20n, 3, 4, 5, 6);
const bankruptPath = positionMerkleProof([bankrupt.commitment], bankrupt.commitment);
fixtures.push({id: "liquidation-check", inputs: {
  is_long: true, size: priceScale, entry_price: 100n, mark_price: 50n, margin: 20n,
  funding_index: fieldHex(-3n), funding_index_abs: 3n, funding_index_is_negative: true,
  current_funding_index_abs: 2n, current_funding_index_is_negative: false,
  funding_payment_abs: 5n, funding_is_credit: false, maintenance_rate: 100_000n,
  price_scale: priceScale, rate_scale: 1_000_000n, position_root: bankruptPath.root,
  position_commitment_public: bankrupt.commitment, position_nullifier: bankrupt.nullifier,
  reward_commitment: h(13), market_digest: market, owner_digest: bankrupt.ownerDigest,
  rho_digest: bankrupt.rhoDigest, blinding: bankrupt.blinding, spend_secret_digest: bankrupt.spendSecretDigest,
  path_siblings: bankruptPath.siblings, path_indices: bankruptPath.indices, zero_value: 0n,
}, publicFields: [50n,100_000n,priceScale,1_000_000n,bankruptPath.root,bankrupt.commitment,bankrupt.nullifier,h(13),market,2n,false]});

const pair = [position("long",20n,3,4,5,6), position("short",20n,13,14,15,16)];
const pairPaths = pair.map(value => positionMerkleProof(pair.map(value => value.commitment),value.commitment));
const payouts = [40n,0n];
const newPositions = pair.map((value,i) => circuitPositionCommitment({...value,size:0n,margin:0n,rhoDigest:h(7+i*10),blinding:h(8+i*10)}));
const pairOutputs = pair.map((value,i) => secureMarginCommitment({amount:payouts[i],assetDigest:asset,
  ownerDigest:value.ownerDigest,rhoDigest:h(10+i*10),blinding:h(11+i*10),spendSecretDigest:h(12+i*10)}));
fixtures.push({id:"position-close-pair", inputs: {
  market_digest:market, asset_digest:asset, mark_price:150n, current_funding_index_abs:2n,
  current_funding_index_is_negative:false, maintenance_rate:100_000n, liquidation:true,
  position_root:pairPaths[0].root, position_commitments:pair.map(value => value.commitment),
  position_nullifiers:pair.map(value => value.nullifier),close_commitments:[h(23),h(24)],
  new_position_commitments:newPositions,margin_output_commitments:pairOutputs,
  is_long:[true,false],size:priceScale,entry_price:100n,funding_index:fieldHex(-3n),
  funding_index_abs:3n,funding_index_is_negative:true,margins:[20n,20n],owner_digests:pair.map(value => value.ownerDigest),
  rhos:pair.map(value => value.rhoDigest),blindings:pair.map(value => value.blinding),
  spend_secret_digests:pair.map(value => value.spendSecretDigest),output_amounts:payouts,
  new_position_rhos:[h(7),h(17)],new_position_blindings:[h(8),h(18)],
  output_rhos:[h(10),h(20)],output_blindings:[h(11),h(21)],output_spend_secrets:[h(12),h(22)],
  path_siblings:pairPaths.map(value => value.siblings),path_indices:pairPaths.map(value => value.indices),
},publicFields:[market,asset,150n,2n,false,100_000n,true,pairPaths[0].root,
  pair.map(value=>value.commitment),pair.map(value=>value.nullifier),[h(23),h(24)],newPositions,pairOutputs]});

const note = {amount:12000n,assetDigest:asset,ownerDigest:h(3),rhoDigest:h(4),blinding:h(5),spendSecretDigest:h(6)};
const noteCommitment = secureMarginCommitment(note);
const noteNullifier = secureMarginNullifier(note);
const notePath = secureMarginProof([noteCommitment],noteCommitment);
const seed = derivePositionSeed(h(6),h(23),h(24));
const intentFields = {batchDigest:h(20),marketDigest:market,ownerCommitmentField:h(22),side:"long" as const,
  size:1n,limitPrice:5100000000000n,margin:12000n,noteNullifier,nonceDigest:h(23),saltDigest:h(24)};
const intent = circuitIntentCommitment(intentFields);
const payload = circuitMatchingPayloadCommitment({intentCommitment:intent,marketDigest:market,ownerDigest:h(3),
  signedSize:1n,limitPrice:intentFields.limitPrice,margin:12000n,noteNullifier,noteChangeCommitment:h(0),positionSeed:seed});
fixtures.push({id:"intent-validity",inputs:{
  size:1n,margin:12000n,limit_price:intentFields.limitPrice,is_long:true,expiry_batch:10n,note_amount:12000n,
  asset_digest:asset,owner_digest:h(3),rho_digest:h(4),blinding:h(5),spend_secret_digest:h(6),
  path_siblings:notePath.siblings,path_indices:notePath.indices,current_batch:9n,batch_digest:h(20),
  market_digest:market,owner_commitment_field:h(22),intent_commitment:intent,margin_root:notePath.root,
  note_commitment_public:noteCommitment,note_nullifier:noteNullifier,nonce_digest:h(23),salt_digest:h(24),
  zero_commitment:0n,change_blinding:h(8),change_rho_digest:h(7),note_change_commitment:h(0),
  position_seed:seed,matching_payload_commitment:payload,
},publicFields:[asset,9n,h(20),market,intent,notePath.root,noteNullifier,h(0),payload]});

const conditional = circuitConditionalOrderCommitment({marketDigest:market,positionNullifier:h(12),side:"long",
  kind:"take-profit",triggerPrice:55n,size:1n,reduceOnly:true,saltDigest:h(14)});
fixtures.push({id:"conditional-close",inputs:{is_long:true,is_take_profit:true,reduce_only:true,market_digest:market,
  trigger_price:55n,mark_price:56n,size:1n,position_nullifier:h(12),close_commitment:conditional,salt_digest:h(14),zero_value:0n},
publicFields:[market,56n,h(12),conditional]});

const prove = process.argv.includes("--prove");
const evidence = fixtures.map(fixture => {
  writeFileSync(join(root,"circuits",fixture.id,"Prover.toml"),
    Object.entries(fixture.inputs).map(([key,value])=>`${key} = ${serialize(value)}`).join("\n")+"\n");
  const expected = inputHash(fixture.publicFields);
  if (!prove) return {circuitId:fixture.id,expectedPublicInputHash:expected};
  const artifact = buildProofArtifact(root,fixture.id);
  if (artifact.publicInputsHash !== expected) throw new Error(`${fixture.id} public ABI mismatch`);
  return {...artifact,sourceHash:loadCircuit(root,fixture.id).sourceHash,expectedPublicInputHash:expected};
});
if (prove) {
  const dir = join(root,".pnlx","verification"); mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,"proof-evidence.json"),JSON.stringify({createdAt:new Date().toISOString(),artifacts:evidence},null,2)+"\n");
}
process.stdout.write(JSON.stringify(evidence,null,2)+"\n");
