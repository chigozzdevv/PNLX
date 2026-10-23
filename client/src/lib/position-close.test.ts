/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { circuitPositionCommitment, circuitPositionNullifier, fieldHex, hashFields, positionSecrets } from "@pnlx/crypto";
import type { Hex } from "@/types/trading";
import { reconstructPositionSecrets } from "./position-close";

describe("private position reconstruction", () => {
  test("uses encrypted private seed at the exact fill index, including indexes above the old scan cap", async () => {
    const input = fixture(900);
    expect(await reconstructPositionSecrets(input)).toEqual({
      ...positionSecrets(input.positionSeed, input.fillIndex), ownerDigest: input.ownerDigest,
      marketDigest: fieldHex(BigInt(hashFields("market-id", [input.marketId]))),
    });
  });

  test("rejects missing private entropy and tampered owner, seed, index or position binding", async () => {
    const input = fixture(5);
    for (const change of [
      { positionSeed: undefined }, { ownerDigest: undefined }, { fillIndex: undefined }, { fillIndex: -1 },
      { positionSeed: "0x01" as Hex }, { ownerDigest: "0x02" as Hex }, { fillIndex: 6 },
      { marketId: "other-market" }, { positionNullifier: "0x03" as Hex }, { positionCommitment: "0x04" as Hex },
    ]) await expect(reconstructPositionSecrets({ ...input, ...change })).rejects.toThrow();
  });
});

function fixture(fillIndex: number) {
  const positionSeed = fieldHex(0x1234n);
  const ownerDigest = fieldHex(0x5678n);
  const marketId = "xlm-usd-perp";
  const secrets = positionSecrets(positionSeed, fillIndex);
  const opening = { entryPrice: 10_000_000n, fundingIndex: -500n, margin: 100_000_000n, side: "long" as const, size: 1_000_000n };
  return { ...opening, ownerDigest, positionSeed, fillIndex, marketId,
    positionCommitment: circuitPositionCommitment({ ...opening, ...secrets, ownerDigest, marketDigest: fieldHex(BigInt(hashFields("market-id", [marketId]))) }),
    positionNullifier: circuitPositionNullifier(secrets),
  };
}
