import { expect, test } from "bun:test";
import { secureMarginCommitment, secureMarginNullifier, secureMarginProof,
  secureMarginRoot } from "./secure-margin-note";
import { fieldHex, fieldHashPair } from "./field-merkle";
import { positionMerkleProof } from "./field-merkle";
import { creditDropGrantBudget, creditDropGrantCommitment, creditDropGrantNullifier,
  creditDropGrantProof, creditDropGrantRoot, creditDropPositionCommitment } from "./credit-drops";

const field = (value: bigint) => fieldHex(value);

test("sponsored position commitments retain the close circuit format and bind their authority", () => {
  const position = { side: "long" as const, size: 100_000_000n, entryPrice: 100n, margin: 100n,
    fundingIndex: 0n, marketDigest: field(2n), ownerDigest: field(3n), rhoDigest: field(4n),
    blinding: field(5n), spendSecretDigest: field(12n), sponsoredPrincipal: 10n, reserveDigest: field(6n) };
  const commitment = creditDropPositionCommitment(position);
  expect(commitment).toBe("0x25b25f3eb0649e31645fc9edca7895003b420b66aab2ffb0f098cc49ca73be6d");
  for (const changed of [
    { ...position, spendSecretDigest: field(13n) },
    { ...position, sponsoredPrincipal: 11n },
    { ...position, reserveDigest: field(14n) },
    { ...position, ownerDigest: field(15n) },
    { ...position, rhoDigest: field(16n) },
    { ...position, blinding: field(17n) },
  ]) expect(creditDropPositionCommitment(changed)).not.toBe(commitment);
  expect(() => creditDropPositionCommitment({ ...position, spendSecretDigest: field(0n) })).toThrow();
});

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

test("Credit Drop grants bind epoch, owner, amount and nonce without publishing the owner", () => {
  const grant = { epochId: field(10n), ownerCommitment: field(11n), amount: 25n, nonce: field(12n) };
  const leaf = creditDropGrantCommitment(grant);
  const nullifier = creditDropGrantNullifier(grant);
  for (const changed of [
    { ...grant, epochId: field(13n) },
    { ...grant, ownerCommitment: field(14n) },
    { ...grant, amount: 26n },
    { ...grant, nonce: field(15n) },
  ]) expect(creditDropGrantCommitment(changed)).not.toBe(leaf);
  expect(creditDropGrantNullifier({ ...grant, nonce: field(15n) })).not.toBe(nullifier);
  const root = creditDropGrantRoot([grant]);
  expect(positionMerkleProof([leaf], leaf).root).toBe(root);
  expect(() => creditDropGrantRoot([grant, grant])).toThrow("Duplicate Credit Drop owner");
});

test("Credit Drop grant proofs use the same canonical order as the epoch root", () => {
  const first = { epochId: field(1n), ownerCommitment: field(2n), amount: 25n, nonce: field(3n) };
  const second = { epochId: field(1n), ownerCommitment: field(4n), amount: 40n, nonce: field(5n) };
  const grants = [second, first];
  const root = creditDropGrantRoot(grants);
  expect(creditDropGrantBudget(grants)).toBe(65n);
  for (const grant of grants) {
    const proof = creditDropGrantProof(grants, grant);
    expect(proof.root).toBe(root);
    expect(proof.leaf).toBe(creditDropGrantCommitment(grant));
    expect(proof.siblings.reduce((node, sibling, index) => proof.indices[index]
      ? fieldHashPair(sibling, node) : fieldHashPair(node, sibling), proof.leaf)).toBe(root);
  }
  expect(() => creditDropGrantProof(grants, { ...first, nonce: field(6n) })).toThrow("leaf not found");
  expect(() => creditDropGrantRoot([first, { ...second, epochId: field(7n) }]))
    .toThrow("share one epoch");
  expect(() => creditDropGrantBudget([{ ...first, amount: 1n << 127n }]))
    .toThrow("contract amount limit");
});
