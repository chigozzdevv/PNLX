import type { FieldShare } from "@pnlx/protocol-types";
import { FIELD_PRIME, hashToField, invert, mod } from "./field";

export function splitSecret(
  secret: bigint,
  threshold: number,
  shareCount: number,
  salt: string,
): FieldShare[] {
  if (threshold < 2) throw new Error("threshold must be at least 2");
  if (shareCount < threshold) throw new Error("share count must satisfy threshold");

  const coefficients = [mod(secret)];
  for (let i = 1; i < threshold; i += 1) {
    coefficients.push(hashToField(`${salt}:${i}`));
  }

  const shares: FieldShare[] = [];
  for (let x = 1n; x <= BigInt(shareCount); x += 1n) {
    let y = 0n;
    for (let power = 0; power < coefficients.length; power += 1) {
      y = mod(y + coefficients[power] * x ** BigInt(power));
    }
    shares.push({ x, y });
  }
  return shares;
}

export function recoverSecret(shares: FieldShare[]): bigint {
  if (shares.length < 2) throw new Error("at least two shares are required");
  let secret = 0n;

  for (let i = 0; i < shares.length; i += 1) {
    const xi = shares[i].x;
    const yi = shares[i].y;
    let numerator = 1n;
    let denominator = 1n;

    for (let j = 0; j < shares.length; j += 1) {
      if (i === j) continue;
      const xj = shares[j].x;
      numerator = mod(numerator * -xj);
      denominator = mod(denominator * (xi - xj));
    }

    secret = mod(secret + yi * numerator * invert(denominator));
  }

  return secret % FIELD_PRIME;
}
