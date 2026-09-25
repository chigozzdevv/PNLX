import { expect, test } from "bun:test";
import {
  circuitMarginCommitment as serverMarginCommitment,
  circuitPositionCommitment as serverPositionCommitment,
} from "@pnlx/crypto";
import { circuitPositionCommitment, createCircuitMarginCommitment, fieldHashPair } from "./private-note";

test("browser note hash matches the Noir, Rust, and Soroban Poseidon2 vector", () => {
  expect(fieldHashPair(1n, 2n)).toBe(
    "0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383",
  );
  expect(fieldHashPair(1n, 139n)).not.toBe(fieldHashPair(138n, 8n));
});

test("browser note commitments match the server for the same private opening", () => {
  const fields = {
    assetDigest: fieldHashPair(3n, 4n),
    blinding: fieldHashPair(5n, 6n),
    ownerDigest: fieldHashPair(7n, 8n),
    rhoDigest: fieldHashPair(9n, 10n),
    spendSecretDigest: fieldHashPair(11n, 12n),
  };
  const margin = { ...fields, amount: 100_000_000n };
  expect(createCircuitMarginCommitment(margin)).toBe(serverMarginCommitment(margin));

  const position = {
    blinding: fields.blinding,
    entryPrice: 19_000_000n,
    fundingIndex: 0n,
    margin: 100_000_000n,
    marketDigest: fields.assetDigest,
    ownerDigest: fields.ownerDigest,
    rhoDigest: fields.rhoDigest,
    spendSecretDigest: fields.spendSecretDigest,
    side: "long" as const,
    size: 500_000_000n,
  };
  expect(circuitPositionCommitment(position)).toBe(serverPositionCommitment(position));
});
