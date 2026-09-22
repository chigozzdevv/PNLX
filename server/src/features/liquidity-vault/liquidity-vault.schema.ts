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
        amount: requiredString(input.amount, "amount"),
        minShares: requiredString(input.minShares, "minShares"),
      };
    case "withdraw":
      return {
        action,
        shares: requiredString(input.shares, "shares"),
        minAssets: requiredString(input.minAssets, "minAssets"),
      };
    case "request-withdraw":
    case "cancel-withdraw-request":
      return { action, shares: requiredString(input.shares, "shares") };
    case "claim-withdrawal":
      return { action, minAssets: requiredString(input.minAssets, "minAssets") };
    case "set-paused":
      if (typeof input.paused !== "boolean") throw new Error("paused must be a boolean");
      return { action, paused: input.paused };
    case "allocate":
      return { action, amount: requiredString(input.amount, "amount") };
    case "settle":
      return {
        action,
        principal: requiredString(input.principal, "principal"),
        returned: requiredString(input.returned, "returned"),
      };
    case "record-loss":
      return { action, principal: requiredString(input.principal, "principal") };
    case "set-allocation-limit":
      if (!Number.isInteger(input.allocationLimitBps)) {
        throw new Error("allocationLimitBps must be an integer");
      }
      return { action, allocationLimitBps: input.allocationLimitBps as number };
    default:
      throw new Error("unsupported liquidity vault action");
  }
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
