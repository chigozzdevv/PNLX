import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fieldMerkleRoot } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";

interface ManifestRecord {
  classification: "position-opening" | "position-close-output";
  commitment: Hex;
  lifecycleEvidence?: {
    positionNullifier: Hex;
    status: "spent-by-position-close";
    txHash: string;
  };
  ordinal: number;
  sourceFunction: "settle" | "settle_manual";
  sourceTxHash: string;
}

describe("legacy position reconciliation manifest", () => {
  test("preserves exactly the chain-proven accumulator without owner guesses", () => {
    const raw = readFileSync(
      "deployments/testnet-legacy-position-reconciliation.json",
      "utf8",
    );
    const manifest = JSON.parse(raw) as {
      reconciledRoot: Hex;
      records: ManifestRecord[];
    };

    expect(manifest.records).toHaveLength(13);
    expect(raw.toLowerCase()).not.toContain("owner");
    expect(manifest.records.map((record) => record.ordinal)).toEqual(
      Array.from({ length: 13 }, (_, index) => index),
    );
    expect(new Set(manifest.records.map((record) => record.commitment)).size).toBe(13);
    expect(fieldMerkleRoot(manifest.records.map((record) => record.commitment))).toBe(
      manifest.reconciledRoot,
    );
    expect(
      manifest.records.filter((record) => record.lifecycleEvidence?.status === "spent-by-position-close"),
    ).toHaveLength(5);
    expect(
      manifest.records.filter((record) => record.classification === "position-close-output"),
    ).toHaveLength(5);
  });
});
