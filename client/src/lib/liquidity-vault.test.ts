import { describe, expect, test } from "bun:test";
import { formatVaultSharePrice, formatVaultUnits, parseVaultUnits, quoteVaultAction, quoteVaultWithdrawalClaim,
  selectVaultAssetPoints,
  quoteVaultWithdrawalRequest, vaultSharePrice, type VaultAccount, type VaultStatus } from "@/lib/liquidity-vault";

const status: VaultStatus = {
  allocationLimitBps: "8000",
  asset: "USDC",
  contractId: "vault",
  currentSeries: 0,
  currentSeriesAssets: "1100000000",
  currentSeriesShares: "1000000000",
  currentSeriesLiquid: "1100000000",
  currentSeriesPrincipal: "0",
  depositSeries: 0,
  depositSeriesAssets: "1100000000",
  depositSeriesShares: "1000000000",
  deployedPrincipal: "0",
  liquidAssets: "1100000000",
  maker: "maker",
  operator: "operator",
  paused: false,
  reconciledAssets: "1100000000",
  totalAssetsAtCost: "1100000000",
  totalShares: "1000000000",
  withdrawalsOpen: true,
};

test("share price uses the held series value and preserves a small loss", () => {
  const price = vaultSharePrice(499_983_157_353n, 500_000_000_000n);
  expect(price).toBe(9_999_663n);
  expect(formatVaultSharePrice(price!)).toBe("0.9999663");
  expect(formatVaultSharePrice(vaultSharePrice(0n, 0n)!)).toBe("1.0000");
  expect(vaultSharePrice(1n, 0n)).toBeNull();
});

const account: VaultAccount = {
  address: "owner",
  availableShares: "100000000",
  deposited: "100000000",
  equity: "110000000",
  pendingShares: "0",
  shares: "100000000",
  positions: [{ series: 0, shares: "100000000", pendingShares: "0", availableShares: "100000000",
    assetsAtCost: "110000000", equity: "110000000", withdrawalsOpen: true,
    seriesAssets: "1100000000", seriesTotalShares: "1000000000" }],
  withdrawn: "0",
};

test("liquidity chart ranges use recorded points and the preceding value", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const points = [
    { at: "2026-08-20T12:00:00Z", assets: "10" },
    { at: "2026-09-14T12:00:00Z", assets: "20" },
    { at: "2026-09-18T12:00:00Z", assets: "30" },
    { at: "2026-09-24T00:00:00Z", assets: "40" },
  ];
  expect(selectVaultAssetPoints(points, "1D", now)).toEqual([
    { at: "2026-09-23T12:00:00.000Z", assets: "30" }, points[3],
  ]);
  expect(selectVaultAssetPoints(points, "7D", now)).toEqual([
    { at: "2026-09-17T12:00:00.000Z", assets: "20" }, points[2], points[3],
  ]);
  expect(selectVaultAssetPoints(points, "30D", now)).toEqual([
    { at: "2026-08-25T12:00:00.000Z", assets: "10" }, points[1], points[2], points[3],
  ]);
  expect(selectVaultAssetPoints(points.slice(0, 3), "1D", now)).toEqual([]);
  expect(selectVaultAssetPoints(points.slice(0, 3), "1D", now, "2026-09-24T11:55:00Z")).toEqual([
    { at: "2026-09-23T12:00:00.000Z", assets: "30" },
    { at: "2026-09-24T11:55:00Z", assets: "30" },
  ]);
});

describe("vault amount and action quotes", () => {
  test("preserves seven-decimal input units", () => {
    expect(parseVaultUnits("11.0000001")).toBe(110000001n);
    expect(formatVaultUnits("110000001", 4)).toBe("11.0000");
    expect(() => parseVaultUnits("1.00000001")).toThrow("7 decimal places");
  });

  test("quotes deposit shares and a minimum before signing", () => {
    const quote = quoteVaultAction("deposit", parseVaultUnits("11"), status);
    expect(quote.estimated).toBe(100000000n);
    expect(quote.action).toEqual({ action: "deposit", series: 0, amount: "110000000", minShares: "99500000" });
  });

  test("quotes withdrawal assets from available shares", () => {
    const quote = quoteVaultAction("withdraw", parseVaultUnits("10"), status, account, 0);
    expect(quote.estimated).toBe(110000000n);
    expect(quote.action).toEqual({ action: "withdraw", series: 0, shares: "100000000", minAssets: "109450000" });
    expect(() => quoteVaultAction("withdraw", parseVaultUnits("11"), status, account, 0)).toThrow("available shares");
  });

  test("mints a fresh position immediately while an older maker allocation remains open", () => {
    const trading = { ...status, currentSeriesPrincipal: "800000000", deployedPrincipal: "800000000",
      depositSeries: 1, depositSeriesAssets: "0", depositSeriesShares: "0" };
    const quote = quoteVaultAction("deposit", parseVaultUnits("11"), trading);
    expect(quote.estimated).toBe(110000000n);
    expect(quote.action).toEqual({ action: "deposit", series: 1, amount: "110000000", minShares: "109450000" });
  });

  test("requests an exit during active allocation and claims the settled shares", () => {
    const active = { ...account.positions[0]!, withdrawalsOpen: false };
    expect(quoteVaultWithdrawalRequest(50_000_000n, active).action)
      .toEqual({ action: "request-withdraw", series: 0, shares: "50000000" });
    expect(() => quoteVaultWithdrawalClaim({ ...active, pendingShares: "50000000" }))
      .toThrow("not ready");
    const claim = quoteVaultWithdrawalClaim({ ...account.positions[0]!, pendingShares: "50000000" });
    expect(claim.action).toEqual({ action: "claim-withdrawal", series: 0, minAssets: "54725000" });
    expect(claim.estimated).toBe(55_000_000n);
  });

  test("does not quote actions outside vault availability", () => {
    expect(() => quoteVaultAction("deposit", 10000000n, { ...status, paused: true })).toThrow("not open");
    expect(() => quoteVaultAction("deposit", 10000000n, { ...status, depositSeriesShares: "0" })).toThrow("deposits are unavailable");
    expect(() => quoteVaultAction("withdraw", 10000000n, status, { ...account, positions: [{ ...account.positions[0]!, withdrawalsOpen: false }] }, 0)).toThrow("settled");
  });
});
