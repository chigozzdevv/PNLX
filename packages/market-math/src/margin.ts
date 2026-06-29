import { PRICE_SCALE, RATE_SCALE } from "./constants";

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function notional(size: bigint, price: bigint): bigint {
  return (abs(size) * price) / PRICE_SCALE;
}

export function initialMargin(size: bigint, price: bigint, rate: bigint): bigint {
  return (notional(size, price) * rate) / RATE_SCALE;
}

export function maintenanceMargin(size: bigint, price: bigint, rate: bigint): bigint {
  return (notional(size, price) * rate) / RATE_SCALE;
}

export function hasInitialMargin(
  size: bigint,
  price: bigint,
  margin: bigint,
  initialRate: bigint,
): boolean {
  return margin >= initialMargin(size, price, initialRate);
}

export function hasMaxLeverage(
  size: bigint,
  price: bigint,
  margin: bigint,
  maxLeverage: bigint,
): boolean {
  if (margin <= 0n || maxLeverage <= 0n) return false;
  return notional(size, price) <= margin * maxLeverage;
}
