import type { AccountSnapshot, PositionRow } from "@/types/trading";

export function accountEquity(account: AccountSnapshot, positions: readonly PositionRow[]) {
  const open = positions.filter((position) => position.status === "open");
  if (account.accountValue === null || !Number.isFinite(account.accountValue) ||
    open.some((position) => position.unrealizedPnl === undefined || !Number.isFinite(position.unrealizedPnl) ||
      (position.entryFee !== undefined && !Number.isFinite(position.entryFee)))) {
    return { equity: null, unrealizedPnl: null };
  }
  const unrealizedPnl = open.reduce((sum, position) => sum + position.unrealizedPnl!, 0);
  const entryFees = open.reduce((sum, position) => sum + (position.entryFee ?? 0), 0);
  return { equity: account.accountValue + unrealizedPnl + entryFees, unrealizedPnl };
}
