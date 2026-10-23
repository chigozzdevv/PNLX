import { expect, test } from "bun:test";
import { circuitPositionCommitment, secureMarginCommitment, creditDropPositionCommitment, fieldHex, positionMerkleProof } from "@pnlx/crypto";
import { buildProofArtifactAsync } from "@pnlx/proof-system";
import { prepareCreditDropClose } from "./credit-drop-close";

const position = { side: "long" as const, size: 100_000_000n, entryPrice: 100n, margin: 100n,
  fundingIndex: 0n, marketDigest: fieldHex(2n), ownerDigest: fieldHex(3n), rhoDigest: fieldHex(4n),
  blinding: fieldHex(5n), spendSecretDigest: fieldHex(12n), sponsoredPrincipal: 10n, reserveDigest: fieldHex(6n) };

export function creditDropCloseFixture() {
  const commitment = creditDropPositionCommitment(position);
  return { position, membership: positionMerkleProof([commitment], commitment, 20),
    assetDigest: fieldHex(7n), markPrice: 120n, currentFundingIndex: 0n, maintenanceRate: 100_000n,
    liquidation: false, outputRho: fieldHex(8n), outputBlinding: fieldHex(9n),
    outputSpendSecretDigest: fieldHex(11n), reserveOutputRho: fieldHex(10n) };
}

test("proves helper-generated sponsored close inputs against the Noir circuit", async () => {
  const close = prepareCreditDropClose(creditDropCloseFixture());
  const artifact = await buildProofArtifactAsync(process.cwd(), "credit-drop-close", {
    name: "sponsored-close-compatibility", inputs: close.inputs,
  });
  expect(artifact.publicInputsHash).toBe(close.publicInputHash);
}, 120_000);

test("sponsored close uses the same accounting for the user output and reserve receipt", () => {
  const input = creditDropCloseFixture();
  const close = prepareCreditDropClose(input);
  expect(close.traderAmount).toBe(110n);
  expect(close.reserveAmount).toBe(10n);
  expect(close.positionCommitment).not.toBe(circuitPositionCommitment(position));
  expect(close.marginOutputCommitment).toBe(secureMarginCommitment({
    assetDigest: input.assetDigest, amount: close.traderAmount, ownerDigest: position.ownerDigest,
    rhoDigest: input.outputRho, blinding: input.outputBlinding,
    spendSecretDigest: input.outputSpendSecretDigest,
  }));
  expect(secureMarginCommitment({ assetDigest: input.assetDigest, amount: close.traderAmount,
    ownerDigest: position.ownerDigest, rhoDigest: input.outputRho, blinding: input.outputBlinding,
    spendSecretDigest: fieldHex(99n) })).not.toBe(close.marginOutputCommitment);
  expect(() => prepareCreditDropClose({ ...input, outputSpendSecretDigest: fieldHex(0n) })).toThrow();
  expect(() => prepareCreditDropClose({ ...input,
    position: { ...position, spendSecretDigest: fieldHex(99n) } })).toThrow();
  expect(() => prepareCreditDropClose({ ...input, position: { ...position, sponsoredPrincipal: 1n } })).toThrow();
});

test("liquidation returns only remaining equity without losing its principal liability", () => {
  const input = creditDropCloseFixture();
  const leveraged = { ...position, size: 1_000_000_000n, margin: 106n };
  const commitment = creditDropPositionCommitment(leveraged);
  const closed = prepareCreditDropClose({ ...input, position: leveraged,
    membership: positionMerkleProof([commitment], commitment, 20), markPrice: 90n, liquidation: true });
  expect(closed.traderAmount).toBe(0n);
  expect(closed.marginOutputCommitment).toBe("0x0");
  expect(closed.reserveAmount).toBe(6n);
  expect(closed.reserveLoss).toBe(4n);
  expect(() => prepareCreditDropClose({ ...input, liquidation: true })).toThrow();
});

test("a fully depleted position creates no zero-value claim", () => {
  const input = creditDropCloseFixture();
  const depleted = { ...position, size: 1_000_000_000n };
  const commitment = creditDropPositionCommitment(depleted);
  const close = prepareCreditDropClose({ ...input, position: depleted,
    membership: positionMerkleProof([commitment], commitment, 20), markPrice: 90n, liquidation: true });
  expect(close.traderAmount).toBe(0n);
  expect(close.reserveAmount).toBe(0n);
  expect(close.marginOutputCommitment).toBe("0x0");
  expect(close.reserveOutputCommitment).toBe("0x0");
});
