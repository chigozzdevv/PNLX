import { describe, expect, test } from "bun:test";
import { makerTopUpAmount, planIncompleteAllocation } from "../../scripts/operations/manage-vault-maker-liquidity";
import { localApiOrigin } from "../../scripts/smoke/custody";

const state = {
  currentSeriesAssets: 500_000_000_000n,
  currentSeriesLiquid: 500_000_000_000n,
  currentSeriesPrincipal: 0n,
  deployedPrincipal: 100_000_000n,
  limitBps: 8_000n,
  readyAmount: 0n,
  targetAmount: 10_000_000_000n,
  totalAssets: 500_200_000_000n,
};

describe("vault maker reserve planning", () => {
  test("operator deposit and recovery use only the local live API", () => {
    expect(localApiOrigin("http://127.0.0.1:4000")).toBe("http://127.0.0.1:4000");
    expect(() => localApiOrigin("https://pnlx.example")).toThrow();
    expect(() => localApiOrigin("http://example.com:4000")).toThrow();
  });
  test("prepares only the missing ready liquidity", () => {
    expect(makerTopUpAmount(state)).toBe(10_000_000_000n);
    expect(makerTopUpAmount({ ...state, readyAmount: 8_000_000_000n }))
      .toBe(2_000_000_000n);
    expect(makerTopUpAmount({ ...state, readyAmount: state.targetAmount })).toBe(0n);
  });

  test("respects per-series and vault caps across repeated allocations", () => {
    expect(makerTopUpAmount({ ...state, currentSeriesPrincipal: 395_000_000_000n,
      currentSeriesLiquid: 105_000_000_000n, deployedPrincipal: 395_100_000_000n }))
      .toBe(5_000_000_000n);
    expect(makerTopUpAmount({ ...state, currentSeriesPrincipal: 399_000_000_000n,
      currentSeriesLiquid: 101_000_000_000n, deployedPrincipal: 400_100_000_000n }))
      .toBe(60_000_000n);
  });

  test("resumes a recorded allocation without allocating twice", () => {
    const allocation = {
      amount: "9900741423", id: "vault:allocation", noteCommitments: [],
      registeredAmount: "0", status: "outstanding" as const,
    };
    expect(planIncompleteAllocation(allocation, [])).toEqual({ kind: "deposit" });
    const commitment = `0x${"a".repeat(64)}`;
    expect(planIncompleteAllocation(allocation, [{ amount: allocation.amount, commitment,
      depositTxHash: `0x${"b".repeat(64)}`, status: "available", vaultAllocationId: allocation.id }]))
      .toEqual({ kind: "register", commitment });
    expect(() => planIncompleteAllocation(allocation, [{ amount: allocation.amount,
      commitment, status: "pending", vaultAllocationId: allocation.id }])).toThrow(/manual reconciliation/);
    expect(() => planIncompleteAllocation({ ...allocation, registeredAmount: "1" }, [])).toThrow(/manual reconciliation/);
  });

});
