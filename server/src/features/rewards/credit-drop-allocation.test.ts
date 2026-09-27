import { describe, expect, test } from "bun:test";
import type { Hex, PositionCloseRecord, PositionLifecycleRecord } from "@pnlx/protocol-types";
import { ProtocolStore } from "@/shared/state/store";
import { allocateWeeklyCreditDrops } from "./credit-drop-allocation";

const MONDAY = Date.UTC(2026, 8, 21);
const NEXT_MONDAY = MONDAY + 7 * 86_400_000;
const owner = (value: number): Hex => `0x${value.toString(16).padStart(64, "0")}`;

function close(store: ProtocolStore, account: Hex, id: number, updatedAt = MONDAY + 86_400_000) {
  const positionCommitment = owner(id);
  const closeCommitment = owner(id + 100);
  store.positionLifecycle.set(positionCommitment, {
    closeCommitment, ownerCommitment: account, positionCommitment,
    status: "closed", updatedAt,
  } as PositionLifecycleRecord);
  store.positionCloses.set(closeCommitment, { settlementTxHash: owner(id + 200) } as PositionCloseRecord);
}

describe("weekly Credit Drop allocation", () => {
  test("divides the whole budget by active points and tier weight", () => {
    const store = new ProtocolStore();
    close(store, owner(1), 10);
    close(store, owner(2), 20);
    close(store, owner(2), 21);
    const shares = allocateWeeklyCreditDrops({ store, budget: 100n, weekStart: MONDAY, now: NEXT_MONDAY });
    expect(shares).toEqual([
      { ownerCommitment: owner(1), activePoints: 15, tier: "Standard", amount: 38n },
      { ownerCommitment: owner(2), activePoints: 25, tier: "Standard", amount: 62n },
    ]);
    expect(shares.reduce((sum, share) => sum + share.amount, 0n)).toBe(100n);
  });

  test("requires a confirmed close in the completed week", () => {
    const store = new ProtocolStore();
    close(store, owner(1), 10, MONDAY - 1);
    close(store, owner(2), 20);
    store.positionCloses.delete(owner(120));
    expect(allocateWeeklyCreditDrops({ store, budget: 100n, weekStart: MONDAY, now: NEXT_MONDAY })).toEqual([]);
    expect(() => allocateWeeklyCreditDrops({ store, budget: 100n, weekStart: MONDAY,
      now: NEXT_MONDAY - 1 })).toThrow();
  });

  test("applies the earned tier's Drop weight to points", () => {
    const store = new ProtocolStore();
    for (let index = 0; index < 25; index += 1) {
      close(store, owner(1), 10 + index, MONDAY + (1 + Math.floor(index / 10)) * 86_400_000);
    }
    for (let index = 0; index < 10; index += 1) close(store, owner(2), 50 + index);
    const shares = allocateWeeklyCreditDrops({ store, budget: 950n, weekStart: MONDAY, now: NEXT_MONDAY });
    expect(shares).toEqual([
      { ownerCommitment: owner(1), activePoints: 250, tier: "Silver", amount: 750n },
      { ownerCommitment: owner(2), activePoints: 100, tier: "Standard", amount: 200n },
    ]);
  });

  test("conserves small budgets with deterministic rounding", () => {
    const store = new ProtocolStore();
    close(store, owner(1), 10);
    close(store, owner(2), 20);
    close(store, owner(3), 30);
    const shares = allocateWeeklyCreditDrops({ store, budget: 2n, weekStart: MONDAY, now: NEXT_MONDAY });
    expect(shares.map((share) => share.amount)).toEqual([1n, 1n]);
  });
});
