import { expect, test } from "bun:test";
import { vaultPerformance } from "./liquidity-vault.performance";

const start = Date.parse("2026-10-01T00:00:00Z");
const day = 86_400_000;
const at = (days: number) => new Date(start + days * day).toISOString();
const point = (days: number, assets: string, shares = "1000000000") => ({ at: at(days), assets, shares });

test("new deposits and withdrawals are excluded from pool yield", () => {
  const flows = [{ id: "deposit", at: at(3), amount: "1000000000", kind: "supply" },
    { id: "withdrawal", at: at(5), amount: "500000000", kind: "withdrawal" }];
  const result = vaultPerformance([point(0, "1000000000"), point(3, "2000000000", "2000000000"),
    point(5, "1500000000", "1500000000")], flows, at(7), false);
  expect(result).toMatchObject({ apy: 0, returnPct: 0, status: "available" });
});

test("weights contributed capital by its time in the pool", () => {
  const result = vaultPerformance([point(0, "1000000000"), point(3.5, "2000000000", "2000000000"),
    point(7, "2015000000", "2000000000")],
  [{ id: "deposit", at: at(3.5), amount: "1000000000", kind: "supply" }], at(7), false);
  expect(result.returnPct).toBeCloseTo(1, 8);
  expect(result.apy).toBeCloseTo((1.01 ** (365 / 7) - 1) * 100, 8);
});

test("preserves real losses and never treats internal allocations or returns as deposits", () => {
  const result = vaultPerformance([point(0, "1000000000"), point(7, "990000000")],
    [{ id: "allocation", at: at(2), amount: "500000000", kind: "allocation" },
      { id: "return", at: at(6), amount: "490000000", kind: "return" }], at(7), false);
  expect(result.returnPct).toBeCloseTo(-1);
  expect(result.apy).toBeLessThan(0);
  expect(vaultPerformance([point(0, "1000000000"), point(7, "0")], [], at(7), false).apy).toBe(-100);
});

test("withholds yield for stale, short, malformed or incomplete cash-flow history", () => {
  const points = [point(0, "1000000000"), point(7, "1010000000")];
  expect(vaultPerformance(points, [], at(7), true).status).toBe("stale");
  expect(vaultPerformance([points[0]], [], at(0.5), false).apy).toBeNull();
  expect(vaultPerformance([points[0], point(7, "2000000000", "2000000000")], [], at(7), false).apy).toBeNull();
  const flow = { id: "same", at: at(2), amount: "100", kind: "supply" };
  expect(vaultPerformance(points, [flow, flow], at(7), false).apy).toBeNull();
  expect(vaultPerformance([point(0, "NaN")], [], at(7), false).apy).toBeNull();
});
