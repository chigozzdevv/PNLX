import { protocolUsdcToDisplay } from "@/lib/asset-units";
import type { Hex, ServerPortfolioSnapshot } from "@/types/trading";

const BASE_SCALE = 10_000_000n;
const PRICE_SCALE = 100_000_000n;
const NOTIONAL_SCALE = BASE_SCALE * PRICE_SCALE;

export interface WalletVolumeOpening {
  entryPrice: string;
  positionCommitment: Hex;
  size: string;
}

export function walletTradedVolumeUsd(
  portfolio: Pick<ServerPortfolioSnapshot, "positions" | "tradedVolume">,
  openings: WalletVolumeOpening[],
): number | null {
  // A present aggregate is authoritative, including an explicit incomplete result.
  // Only older API responses without the field use locally decrypted history.
  if (Object.hasOwn(portfolio, "tradedVolume")) {
    const aggregate: unknown = portfolio.tradedVolume;
    if (!aggregate || typeof aggregate !== "object" || Array.isArray(aggregate)) return null;
    const { amount, source, status } = aggregate as Record<string, unknown>;
    if (status !== "available" || source !== "pnlx-confirmed-fills" ||
        typeof amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(amount)) return null;
    const volume = protocolUsdcToDisplay(amount);
    return Number.isFinite(volume) && volume >= 0 ? volume : null;
  }

  return walletMatchedVolumeUsd(openings, portfolio.positions.map((position) => position.positionCommitment));
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
