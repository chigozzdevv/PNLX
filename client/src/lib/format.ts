export function formatUsd(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
    ...options,
  }).format(value);
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number, fractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPct(value: number, fractionDigits = 2): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, fractionDigits)}%`;
}

export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function priceFromOracleString(value: string): number {
  return Number(BigInt(value)) / 100_000_000;
}

export function rateFromMicroBps(value: string): number {
  return Number(BigInt(value)) / 1_000_000;
}
