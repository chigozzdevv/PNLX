import { describe, expect, test } from "bun:test";
import { formatVaultUnits, parseVaultUnits, quoteVaultAction, type VaultAccount, type VaultStatus } from "@/lib/liquidity-vault";

const status: VaultStatus = {
  allocationLimitBps: "8000",
  asset: "USDC",
  contractId: "vault",
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

const account: VaultAccount = {
  address: "owner",
  availableShares: "100000000",
  deposited: "100000000",
  equity: "110000000",
  pendingShares: "0",
  shares: "100000000",
  withdrawn: "0",
};

describe("vault amount and action quotes", () => {
  test("preserves seven-decimal input units", () => {
    expect(parseVaultUnits("11.0000001")).toBe(110000001n);
    expect(formatVaultUnits("110000001", 4)).toBe("11.0000");
    expect(() => parseVaultUnits("1.00000001")).toThrow("7 decimal places");
  });

  test("quotes deposit shares and a minimum before signing", () => {
    const quote = quoteVaultAction("deposit", parseVaultUnits("11"), status);
    expect(quote.estimated).toBe(100000000n);
    expect(quote.action).toEqual({ action: "deposit", amount: "110000000", minShares: "99500000" });
  });

  test("quotes withdrawal assets from available shares", () => {
    const quote = quoteVaultAction("withdraw", parseVaultUnits("10"), status, account);
    expect(quote.estimated).toBe(110000000n);
    expect(quote.action).toEqual({ action: "withdraw", shares: "100000000", minAssets: "109450000" });
    expect(() => quoteVaultAction("withdraw", parseVaultUnits("11"), status, account)).toThrow("available shares");
  });

  test("does not quote actions outside vault availability", () => {
    expect(() => quoteVaultAction("deposit", 10000000n, { ...status, paused: true })).toThrow("not open");
    expect(() => quoteVaultAction("deposit", 10000000n, { ...status, totalShares: "0" })).toThrow("deposits are unavailable");
    expect(() => quoteVaultAction("withdraw", 10000000n, { ...status, deployedPrincipal: "1", withdrawalsOpen: false }, account)).toThrow("settled");
  });
});
