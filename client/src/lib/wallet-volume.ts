import type { Hex } from "@/types/trading";

const BASE_SCALE = 10_000_000n;
const PRICE_SCALE = 100_000_000n;
const NOTIONAL_SCALE = BASE_SCALE * PRICE_SCALE;

export interface WalletVolumeOpening {
  entryPrice: string;
  positionCommitment: Hex;
  size: string;
}

export function walletMatchedVolumeUsd(
  openings: WalletVolumeOpening[],
  expectedPositionCommitments: Hex[],
): number | null {
  const expected = new Set(expectedPositionCommitments);
  if (expected.size === 0) return 0;

  const byPosition = new Map<Hex, WalletVolumeOpening>();
  for (const opening of openings) {
    if (!expected.has(opening.positionCommitment)) continue;

    const existing = byPosition.get(opening.positionCommitment);
    if (existing) {
      if (existing.entryPrice !== opening.entryPrice || existing.size !== opening.size) {
        return null;
      }
      continue;
    }
    byPosition.set(opening.positionCommitment, opening);
  }

  if ([...expected].some((commitment) => !byPosition.has(commitment))) {
    return null;
  }

  let rawNotional = 0n;
  try {
    for (const opening of byPosition.values()) {
      const size = BigInt(opening.size);
      const price = BigInt(opening.entryPrice);
      if (size <= 0n || price <= 0n) return null;
      rawNotional += size * price;
    }
  } catch {
    return null;
  }

  const whole = rawNotional / NOTIONAL_SCALE;
  const fraction = rawNotional % NOTIONAL_SCALE;
  const volume = Number(whole) + Number(fraction) / Number(NOTIONAL_SCALE);
  return Number.isFinite(volume) ? volume : null;
}
