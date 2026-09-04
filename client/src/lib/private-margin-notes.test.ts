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
  selectWithdrawablePrivateMarginNote,
  setPrivateMarginNoteRuntimeScope,
  type StoredPrivateMarginNote,
} from "@/lib/private-margin-notes";
import {
  protocolOrderSize,
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
    expect(allocations.map((allocation) => protocolOrderSize(allocation.amount, 10, 1))).toEqual([
      180n,
      80n,
    ]);
  });

  test("keeps a rounding reserve in every private balance input", () => {
    const size = protocolOrderSize(10_000_000n, 10, 0.16);
    const price = 16_000_000n;
    const notional = (size * price) / 100_000_000n;

    expect(notional).toBeLessThanOrEqual((10_000_000n - 32n) * 10n);
    expect(size).toBeGreaterThan(0n);
  });

  test("keeps new deposits consolidated instead of splitting around the current ticket", () => {
    expect(splitDepositAmounts(1_000n, 250)).toEqual([1_000n]);
  });

  test("withdraws the private note selected by its commitment", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        dispatchEvent: () => true,
        localStorage: new MemoryStorage(),
        sessionStorage: new MemoryStorage(),
      },
    });

    try {
      setPrivateMarginNoteRuntimeScope("test:selected-withdrawal");
      const smaller = savePrivateMarginNote(note("small", 30n));
      savePrivateMarginNote(note("large", 90n));

      expect(selectWithdrawablePrivateMarginNote({
        assetDigest: ASSET,
        commitment: smaller.commitment,
        ownerCommitment: OWNER,
      }).commitment).toBe(smaller.commitment);
    } finally {
      setPrivateMarginNoteRuntimeScope(undefined);
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
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

  test("releases a cancelled source note and consumes its pending change", () => {
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
      setPrivateMarginNoteRuntimeScope("test:cancelled-source");
      const intentCommitment = `0x${"AA".repeat(32)}` as Hex;
      savePrivateMarginNote({
        ...note("source", 4_000_000n),
        lockedByIntentCommitment: intentCommitment,
        status: "locked",
      });
      savePrivateMarginNote({
        ...note("change", 2_000_000n),
        lockedByIntentCommitment: intentCommitment,
        status: "pending",
      });

      // API commitments are canonical lowercase while older browser storage
      // can retain uppercase hex from the client proof result.
      reconcilePrivateMarginNotes({
        orders: [{
          intentCommitment: intentCommitment.toLowerCase() as Hex,
          noteNullifier: `0x${"73".repeat(32)}` as Hex,
          status: "cancelled",
        }],
      });

      expect(privateSpendableBalance(OWNER)).toBe(4_000_000n);
      expect(privateReservedBalance(OWNER)).toBe(0n);
      expect(privatePendingBalance(OWNER)).toBe(0n);
      expect(Object.fromEntries(privateMarginNotes(OWNER).map((item) => [item.amount, item.status]))).toEqual({
        "4000000": "available",
        "2000000": "spent",
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

  test("releases a residual source change when the residual is cancelled", () => {
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
      setPrivateMarginNoteRuntimeScope("test:cancelled-residual");
      const sourceIntentCommitment = `0x${"55".repeat(32)}` as Hex;
      const residualIntentCommitment = `0x${"66".repeat(32)}` as Hex;
      savePrivateMarginNote({
        ...note("source", 4_000_000n),
        lockedByIntentCommitment: sourceIntentCommitment,
        status: "locked",
      });
      savePrivateMarginNote({
        ...note("change", 2_000_000n),
        lockedByIntentCommitment: sourceIntentCommitment,
        status: "pending",
      });

      reconcilePrivateMarginNotes({
        orders: [{
          intentCommitment: residualIntentCommitment,
          sourceIntentCommitment,
          status: "cancelled",
        }],
      });

      expect(privateSpendableBalance(OWNER)).toBe(2_000_000n);
      expect(privateReservedBalance(OWNER)).toBe(0n);
      expect(privatePendingBalance(OWNER)).toBe(0n);
      expect(Object.fromEntries(privateMarginNotes(OWNER).map((item) => [item.amount, item.status]))).toEqual({
        "4000000": "spent",
        "2000000": "available",
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

  test("releases the matching source and change through its cancelled note nullifier", () => {
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
      setPrivateMarginNoteRuntimeScope("test:cancelled-nullifier");
      const localIntentCommitment = `0x${"A1".repeat(32)}` as Hex;
      const serverIntentCommitment = `0x${"B2".repeat(32)}` as Hex;
      const noteNullifier = `0x${"C3".repeat(32)}` as Hex;
      savePrivateMarginNote({
        ...note("source", 4_000_000n),
        lockedByIntentCommitment: localIntentCommitment,
        noteNullifier,
        status: "locked",
      });
      savePrivateMarginNote({
        ...note("change", 2_000_000n),
        lockedByIntentCommitment: localIntentCommitment,
        status: "pending",
      });

      reconcilePrivateMarginNotes({
        orders: [{ intentCommitment: serverIntentCommitment, noteNullifier, status: "cancelled" }],
      });

      expect(privateSpendableBalance(OWNER)).toBe(4_000_000n);
      expect(privateReservedBalance(OWNER)).toBe(0n);
      expect(privatePendingBalance(OWNER)).toBe(0n);
      expect(Object.fromEntries(privateMarginNotes(OWNER).map((item) => [item.amount, item.status]))).toEqual({
        "4000000": "available",
        "2000000": "spent",
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

  test("does not release an active order because an older order shares its note nullifier", () => {
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
      setPrivateMarginNoteRuntimeScope("test:active-nullifier");
      const staleIntentCommitment = `0x${"A1".repeat(32)}` as Hex;
      const activeIntentCommitment = `0x${"B2".repeat(32)}` as Hex;
      const localIntentCommitment = `0x${"C3".repeat(32)}` as Hex;
      const noteNullifier = `0x${"D4".repeat(32)}` as Hex;
      savePrivateMarginNote({
        ...note("source", 4_000_000n),
        lockedByIntentCommitment: localIntentCommitment,
        noteNullifier,
        status: "locked",
      });
      savePrivateMarginNote({
        ...note("change", 2_000_000n),
        lockedByIntentCommitment: localIntentCommitment,
        status: "pending",
      });

      reconcilePrivateMarginNotes({
        orders: [
          { intentCommitment: staleIntentCommitment, noteNullifier, status: "cancelled" },
          { intentCommitment: activeIntentCommitment, noteNullifier, status: "open" },
        ],
      });

      expect(privateSpendableBalance(OWNER)).toBe(0n);
      expect(privateReservedBalance(OWNER)).toBe(2_000_000n);
      expect(privatePendingBalance(OWNER)).toBe(2_000_000n);
      expect(Object.fromEntries(privateMarginNotes(OWNER).map((item) => [item.amount, item.status]))).toEqual({
        "4000000": "locked",
        "2000000": "pending",
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
