import { describe, expect, test } from "bun:test";
import { circuitPositionCommitment, digestToFieldHex, positionMerkleProof } from "../../packages/crypto/src/index";
import { legacyPairFixture, legacyPairProofPlan, legacyPositionCommitment } from "../../scripts/proof/legacy-position-close-pair";

describe("bounded legacy position pair exit",()=>{
  test("V1 source commitment remains distinct from V2 while the gap payout conserves pair capital",()=>{
    const inputs=legacyPairFixture();
    expect(legacyPositionCommitment(inputs[0])).toBe(inputs[0].positionCommitment);
    expect(circuitPositionCommitment(inputs[0])).not.toBe(inputs[0].positionCommitment);
    expect(inputs.map(i=>i.marginOutputAmount)).toEqual([40n,0n]);
    const plan=legacyPairProofPlan(inputs,100_000n);
    expect(plan.input.legacy_market_digest).toBe(digestToFieldHex("market:legacy-fixture-btc"));
    expect(plan.input.market_digest).not.toBe(plan.input.legacy_market_digest);
    expect(plan.input.owner_digests).toEqual(inputs.map(i=>i.ownerDigest));
    expect(plan.publicInputHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
  test("an untouched remaining pair can refresh membership after a prior confirmed terminal append",()=>{
    const inputs=legacyPairFixture(),before=legacyPairProofPlan(inputs,100_000n);
    const confirmedTerminals=[digestToFieldHex("prior-confirmed-terminal-0"),digestToFieldHex("prior-confirmed-terminal-1")];
    const currentTree=[...inputs.map(i=>i.positionCommitment),...confirmedTerminals];
    for(const input of inputs){const path=positionMerkleProof(currentTree,input.positionCommitment);
      input.positionRoot=path.root;input.pathSiblings=path.siblings;input.pathIndices=path.indices;}
    const refreshed=legacyPairProofPlan(inputs,100_000n);
    expect(refreshed.input.position_root).not.toBe(before.input.position_root);
    expect(refreshed.publicInputHash).not.toBe(before.publicInputHash);
    expect(refreshed.input.position_commitments).toEqual(before.input.position_commitments);
    expect(refreshed.input.owner_digests).toEqual(before.input.owner_digests);
  });
  test("rejects inflated winner output, forged authority, wrong market and mismatched pair",()=>{
    for(const mutate of [
      (i:ReturnType<typeof legacyPairFixture>)=>{i[0].marginOutputAmount=45n;},
      (i:ReturnType<typeof legacyPairFixture>)=>{i[0].spendSecretDigest=digestToFieldHex("forged");},
      (i:ReturnType<typeof legacyPairFixture>)=>{i[0].marketDigest=digestToFieldHex("wrong market");},
      (i:ReturnType<typeof legacyPairFixture>)=>{i[1].size+=1n;},
      (i:ReturnType<typeof legacyPairFixture>)=>{i[0].pathSiblings[0]=digestToFieldHex("wrong sibling");},
    ]){const inputs=legacyPairFixture();mutate(inputs);expect(()=>legacyPairProofPlan(inputs,100_000n)).toThrow();}
  });
});
