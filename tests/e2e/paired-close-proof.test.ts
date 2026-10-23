import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashFields, fieldHex } from "@pnlx/crypto";
import type { Hex, PositionCloseWitness } from "@pnlx/protocol-types";
import { ProverService } from "../../server/src/workers/prover/prover.service";

function witnesses(): [PositionCloseWitness,PositionCloseWitness] {
  const fixture = Object.fromEntries(readFileSync(resolve("circuits/position-close-pair/Prover.toml"),"utf8")
    .trim().split("\n").map(line => {
      const separator = line.indexOf(" = ");
      return [line.slice(0,separator),JSON.parse(line.slice(separator+3))];
    }));
  const marketId = "fixture-btc-usd";
  const at = (key:string,i:number):Hex => fieldHex(BigInt(fixture[key][i]));
  return [0,1].map(i => ({
    marketId, marketDigest:fieldHex(BigInt(hashFields("market-id",[marketId]))),
    positionRoot:fixture.position_root, positionCommitment:at("position_commitments",i),
    positionNullifier:at("position_nullifiers",i),closeCommitment:at("close_commitments",i),
    side:i===0?"long":"short",size:100_000_000n,closeSize:100_000_000n,entryPrice:100n,
    markPrice:150n,margin:20n,fundingIndex:-3n,currentFundingIndex:2n,fundingPayment:i===0?5n:-5n,
    fee:0n,newMargin:i===0?40n:0n,remainingMargin:0n,marginOutputAmount:i===0?40n:0n,
    newPositionCommitment:at("new_position_commitments",i),marginOutputCommitment:at("margin_output_commitments",i),
    ownerDigest:at("owner_digests",i),rhoDigest:at("rhos",i),blinding:at("blindings",i),
    spendSecretDigest:at("spend_secret_digests",i),newPositionRhoDigest:at("new_position_rhos",i),
    newPositionBlinding:at("new_position_blindings",i),marginOutputAssetDigest:fixture.asset_digest,
    marginOutputRhoDigest:at("output_rhos",i),marginOutputBlinding:at("output_blindings",i),
    marginOutputSpendSecretDigest:at("output_spend_secrets",i),
    pathSiblings:fixture.path_siblings[i],pathIndices:fixture.path_indices[i],
  })) as [PositionCloseWitness,PositionCloseWitness];
}

describe("combined conserved close proofs",()=>{
  test("rejects forged payout, funding, market and membership before proving",async()=>{
    const prover = new ProverService();
    for (const change of [
      {marginOutputAmount:41n,newMargin:41n}, {fundingPayment:0n},
      {marketDigest:"0x99" as Hex}, {positionRoot:"0x99" as Hex},
    ]) {
      const pair = witnesses(); pair[0] = {...pair[0],...change};
      expect(()=>prover.provePositionClosePair(pair,100_000n,true)).toThrow();
      await expect(prover.provePositionClosePairAsync(pair,100_000n,true)).rejects.toThrow();
    }
  });
  test("proves and verifies a gap loss asynchronously with a capped winner and zero-equity loser",async()=>{
    const prover = new ProverService();
    let ticked = false;
    const tick = setTimeout(() => { ticked = true; }, 0);
    const pair = await prover.provePositionClosePairAsync(witnesses(),100_000n,true);
    clearTimeout(tick);
    expect(ticked).toBe(true);
    expect(pair.proof.circuitId).toBe("position-close-pair");
    expect(pair.positions[0].proof).toEqual(pair.positions[1].proof);
    expect(pair.proof.publicInputHash).toBe("0xfce59b2f3775c823d84c39d20130fbffb93e721c59af39639a850b52265eb6f9");
    expect(pair.proof.proofSystem).toBe("noir-ultrahonk");
    expect(prover.artifactFor(pair.proof)).toBeDefined();
  },120_000);
});
