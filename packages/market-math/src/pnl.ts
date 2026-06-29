import { PRICE_SCALE } from "./constants";

export function unrealizedPnl(
  side: "long" | "short",
  size: bigint,
  entryPrice: bigint,
  markPrice: bigint,
): bigint {
  const delta = side === "long" ? markPrice - entryPrice : entryPrice - markPrice;
  return (size * delta) / PRICE_SCALE;
}

export interface CloseSettlementInput {
  side: "long" | "short";
  closeSize: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  margin: bigint;
  fundingPayment: bigint;
  fee: bigint;
}

export interface CloseSettlement {
  realizedPnl: bigint;
  newMargin: bigint;
}

export function settleClose(input: CloseSettlementInput): CloseSettlement {
  if (input.closeSize <= 0n) throw new Error("close size must be positive");
  if (input.margin < 0n) throw new Error("margin cannot be negative");
  if (input.fee < 0n) throw new Error("fee cannot be negative");

  const realizedPnl = unrealizedPnl(
    input.side,
    input.closeSize,
    input.entryPrice,
    input.markPrice,
  );
  const newMargin = input.margin + realizedPnl - input.fundingPayment - input.fee;
  if (newMargin < 0n) throw new Error("close settlement is insolvent");

  return { realizedPnl, newMargin };
}
