/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Hex } from "@/types/trading";
import {
  planPrivateMarginNoteAllocations,
  type StoredPrivateMarginNote,
} from "@/lib/private-margin-notes";
import {
  allocateProtocolSizes,
  splitDepositAmounts,
} from "@/lib/trade-submit";

const OWNER = `0x${"11".repeat(32)}` as Hex;
const ASSET = `0x${"22".repeat(32)}` as Hex;

describe("private margin note allocation", () => {
  test("uses one consolidated note when it can cover the requested margin", () => {
    const allocations = planPrivateMarginNoteAllocations({
      amount: 70n,
      assetDigest: ASSET,
      notes: [note("small", 40n), note("large", 100n)],
      ownerCommitment: OWNER,
    });

    expect(allocations.map((allocation) => [allocation.note.amount, allocation.amount])).toEqual([
      ["100", 70n],
    ]);
  });

  test("spreads one trade across distinct notes when the total is sufficient", () => {
    const allocations = planPrivateMarginNoteAllocations({
      amount: 90n,
      assetDigest: ASSET,
      notes: [note("one", 30n), note("two", 40n), note("three", 50n)],
      ownerCommitment: OWNER,
    });

    expect(allocations.map((allocation) => [allocation.note.amount, allocation.amount])).toEqual([
      ["50", 50n],
      ["40", 40n],
    ]);
    expect(allocateProtocolSizes(900n, 90n, allocations.map((allocation) => allocation.amount))).toEqual([
      500n,
      400n,
    ]);
  });

  test("keeps new deposits consolidated instead of splitting around the current ticket", () => {
    expect(splitDepositAmounts(1_000n, 250)).toEqual([1_000n]);
  });
});

function note(label: string, amount: bigint): StoredPrivateMarginNote {
  const digest = label.charCodeAt(0).toString(16).padStart(2, "0").repeat(32);
  return {
    amount: amount.toString(),
    assetDigest: ASSET,
    blinding: `0x${digest}` as Hex,
    commitment: `0x${digest}` as Hex,
    createdAt: 1,
    noteNullifier: `0x${digest}` as Hex,
    ownerCommitment: OWNER,
    ownerDigest: `0x${digest}` as Hex,
    rhoDigest: `0x${digest}` as Hex,
    spendSecretDigest: `0x${digest}` as Hex,
    status: "available",
    updatedAt: 1,
    walletAddress: "GTEST",
  };
}
