import { expect, test } from "bun:test";
import { secureMarginCommitment, secureMarginNullifier, secureMarginProof,
  secureMarginRoot } from "./secure-margin-note";
import { fieldHex, fieldHashPair } from "./field-merkle";

const field = (value: bigint) => fieldHex(value);

test("secure payout notes bind their nullifier secret and use the contract tree root", () => {
  const note = { amount: 10_000n, assetDigest: field(2n), ownerDigest: field(3n),
    rhoDigest: field(4n), blinding: field(5n), spendSecretDigest: field(6n) };
  const commitment = secureMarginCommitment(note);
  expect(commitment).toBe("0x035f78347b7ba43d2a518a2aca73ccb7256d643d436b448cba8ea4ce0308e62b");
  expect(secureMarginNullifier(note)).toBe("0x1e5b6784a0b506d867200787b035615801d32818756b0df4caf2263036ca6f82");
  expect(secureMarginCommitment({ ...note, spendSecretDigest: field(7n) })).not.toBe(commitment);
  const proof = secureMarginProof([commitment], commitment);
  expect(proof.root).toBe(secureMarginRoot([commitment]));
  expect(proof.siblings.reduce((node, sibling, index) => proof.indices[index]
    ? fieldHashPair(sibling, node) : fieldHashPair(node, sibling), commitment)).toBe(proof.root);
});
