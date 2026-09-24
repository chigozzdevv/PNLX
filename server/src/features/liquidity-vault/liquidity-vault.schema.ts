import type { PrepareVaultInput, VaultAction } from "@/features/liquidity-vault/liquidity-vault.model";

export function parsePrepareVault(input: Record<string, unknown>): PrepareVaultInput {
  const owner = requiredString(input.owner, "owner");
  const action = requiredObject(input.action, "action");
  return { action: parseVaultAction(action), owner };
}

function parseVaultAction(input: Record<string, unknown>): VaultAction {
  const action = requiredString(input.action, "action");
  switch (action) {
    case "deposit":
      return {
        action,
        series: requiredSeries(input.series),
        amount: requiredString(input.amount, "amount"),
        minShares: requiredString(input.minShares, "minShares"),
      };
    case "withdraw":
      return {
        action,
        series: requiredSeries(input.series),
        shares: requiredString(input.shares, "shares"),
        minAssets: requiredString(input.minAssets, "minAssets"),
      };
    case "request-withdraw":
    case "cancel-withdraw-request":
      return { action, series: requiredSeries(input.series), shares: requiredString(input.shares, "shares") };
    case "claim-withdrawal":
      return { action, series: requiredSeries(input.series), minAssets: requiredString(input.minAssets, "minAssets") };
    case "set-paused":
      if (typeof input.paused !== "boolean") throw new Error("paused must be a boolean");
      return { action, paused: input.paused };
    case "allocate":
      return { action, series: requiredSeries(input.series), amount: requiredString(input.amount, "amount") };
    case "settle":
      return {
        action,
        series: requiredSeries(input.series),
        principal: requiredString(input.principal, "principal"),
        returned: requiredString(input.returned, "returned"),
      };
    case "record-loss":
      return { action, series: requiredSeries(input.series), principal: requiredString(input.principal, "principal") };
    case "set-allocation-limit":
      if (!Number.isInteger(input.allocationLimitBps)) {
        throw new Error("allocationLimitBps must be an integer");
      }
      return { action, allocationLimitBps: input.allocationLimitBps as number };
    default:
      throw new Error("unsupported liquidity vault action");
  }
}

function requiredSeries(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new Error("series must be a nonnegative u32");
  }
  return value as number;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is required`);
  }
  return value as Record<string, unknown>;
}
