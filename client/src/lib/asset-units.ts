export const USDC_SCALE = 1_000_000;

export function usdcToProtocolAmount(value: number, label = "USDC amount"): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  const scaled = BigInt(Math.round(value * USDC_SCALE));
  if (scaled <= 0n) {
    throw new Error(`${label} must be positive`);
  }
  return scaled;
}

export function protocolUsdcToDisplay(value: bigint | string | undefined): number {
  if (value === undefined) return 0;
  const amount = typeof value === "bigint" ? value : BigInt(value);
  return Number(amount) / USDC_SCALE;
}

export function protocolBaseToDisplay(value: bigint | string | undefined): number {
  if (value === undefined) return 0;
  const amount = typeof value === "bigint" ? value : BigInt(value);
  return Number(amount) / USDC_SCALE;
}
