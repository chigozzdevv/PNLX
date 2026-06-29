import { createHash } from "node:crypto";

export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function mod(value: bigint): bigint {
  const out = value % FIELD_PRIME;
  return out >= 0n ? out : out + FIELD_PRIME;
}

export function invert(value: bigint): bigint {
  let t = 0n;
  let nextT = 1n;
  let r = FIELD_PRIME;
  let nextR = mod(value);

  while (nextR !== 0n) {
    const q = r / nextR;
    [t, nextT] = [nextT, t - q * nextT];
    [r, nextR] = [nextR, r - q * nextR];
  }

  if (r > 1n) throw new Error("field element is not invertible");
  return mod(t);
}

export function hashToField(input: string): bigint {
  const digest = createHash("sha256").update(input).digest("hex");
  return BigInt(`0x${digest}`) % FIELD_PRIME;
}

export function encodeSigned(value: bigint): bigint {
  return mod(value);
}

export function decodeSigned(value: bigint): bigint {
  const normalized = mod(value);
  return normalized > FIELD_PRIME / 2n ? normalized - FIELD_PRIME : normalized;
}
