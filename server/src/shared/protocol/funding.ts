import type { Side } from "@merkl/protocol-types";

export function expectedFundingPayment(
  side: Side,
  positionSize: bigint,
  currentIndex: bigint,
  positionIndex: bigint,
): bigint {
  if (positionSize <= 0n) throw new Error("position size must be positive");
  const payment = positionSize * (currentIndex - positionIndex);
  return side === "long" ? payment : -payment;
}

export function assertFundingPayment(
  provided: bigint,
  side: Side,
  positionSize: bigint,
  currentIndex: bigint,
  positionIndex: bigint,
): void {
  const expected = expectedFundingPayment(side, positionSize, currentIndex, positionIndex);
  if (provided !== expected) throw new Error("invalid funding payment");
}
