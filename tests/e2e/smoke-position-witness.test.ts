import { expect, test } from "bun:test";
import { digestToFieldHex, positionSecrets } from "@pnlx/crypto";
import { createCircuitPositionNote } from "@pnlx/sdk";
import { reconstructSmokePosition } from "../../scripts/smoke/position-witness";

test("smoke reconstruction uses private authority at the actual output index", () => {
  const source = { marketId: "xlm-usd-perp", ownerCommitment: digestToFieldHex("owner"), ownerDigest: digestToFieldHex("private-owner"),
    positionSeed: digestToFieldHex("private-position-seed") };
  const opening = { marketId: source.marketId, side: "long" as const, size: 100n, entryPrice: 100n, margin: 100n, fundingIndex: -10n };
  const secrets = positionSecrets(source.positionSeed, 2);
  const note = createCircuitPositionNote({ ...opening, ...secrets, blindingDigest: secrets.blinding,
    owner: source.ownerCommitment, ownerDigest: source.ownerDigest, rho: "", blinding: "", spendSecret: "" });
  const input = { ...opening, source, positionCommitments: [digestToFieldHex("other-0"), digestToFieldHex("other-1"), note.commitment] };
  expect(reconstructSmokePosition(input)).toEqual(note);
  expect(() => reconstructSmokePosition({ ...input, source: { ...source, positionSeed: digestToFieldHex("wrong-private-seed") } })).toThrow("does not match");
});
