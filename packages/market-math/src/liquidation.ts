import { maintenanceMargin } from "./margin";
import { unrealizedPnl } from "./pnl";

export function equity(
  side: "long" | "short",
  size: bigint,
  entryPrice: bigint,
  markPrice: bigint,
  margin: bigint,
  fundingPayment: bigint,
): bigint {
  return margin + unrealizedPnl(side, size, entryPrice, markPrice) - fundingPayment;
}

export function isLiquidatable(input: {
  side: "long" | "short";
  size: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  margin: bigint;
  fundingPayment: bigint;
  maintenanceRate: bigint;
}): boolean {
  return (
    equity(
      input.side,
      input.size,
      input.entryPrice,
      input.markPrice,
      input.margin,
      input.fundingPayment,
    ) < maintenanceMargin(input.size, input.markPrice, input.maintenanceRate)
  );
}
