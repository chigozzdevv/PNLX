/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { Hex } from "@/types/trading";
import {
  planPrivateMarginNoteAllocations,
  privateMarginNotes,
  privatePendingBalance,
  privateReservedBalance,
  privateSpendableBalance,
  reconcilePrivateMarginNotes,
  savePrivateMarginNote,
  setPrivateMarginNoteRuntimeScope,
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

  test("releases filled-order change instead of double-counting locked margin", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        dispatchEvent: () => true,
        localStorage,
        sessionStorage,
      },
    });

    try {
      setPrivateMarginNoteRuntimeScope("test:filled-change");
      const intentCommitment = `0x${"44".repeat(32)}` as Hex;
      savePrivateMarginNote({
        ...note("source", 10_000_000n),
        lockedByIntentCommitment: intentCommitment,
        status: "locked",
      });
      savePrivateMarginNote({
        ...note("change", 5_000_000n),
        lockedByIntentCommitment: intentCommitment,
        status: "pending",
      });

      expect(privateReservedBalance(OWNER)).toBe(5_000_000n);
      expect(privatePendingBalance(OWNER)).toBe(5_000_000n);

      reconcilePrivateMarginNotes({
        orders: [{ intentCommitment, status: "filled" }],
      });

      expect(privateSpendableBalance(OWNER)).toBe(5_000_000n);
      expect(privateReservedBalance(OWNER)).toBe(0n);
      expect(privatePendingBalance(OWNER)).toBe(0n);
      expect(Object.fromEntries(privateMarginNotes(OWNER).map((item) => [item.amount, item.status]))).toEqual({
        "10000000": "spent",
        "5000000": "available",
      });
    } finally {
      setPrivateMarginNoteRuntimeScope(undefined);
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

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
