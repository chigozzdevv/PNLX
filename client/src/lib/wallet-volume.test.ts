import { describe, expect, test } from "bun:test";
import { walletMatchedVolumeUsd, type WalletVolumeOpening } from "@/lib/wallet-volume";
import type { Hex } from "@/types/trading";

describe("wallet matched volume", () => {
  test("sums USD notional for distinct matched fills", () => {
    expect(walletMatchedVolumeUsd([
      opening("a", 20_000_000n, 150_000_000n),
      opening("b", 5_000_000n, 200_000_000n),
    ], [commitment("a"), commitment("b")])).toBe(4);
  });

  test("counts a recovered duplicate position only once", () => {
    const fill = opening("a", 10_000_000n, 250_000_000n);
    expect(walletMatchedVolumeUsd([fill, { ...fill }], [commitment("a")])).toBe(2.5);
  });

  test("counts distinct partial fills from the same order", () => {
    expect(walletMatchedVolumeUsd([
      opening("a", 4_000_000n, 100_000_000n),
      opening("b", 6_000_000n, 100_000_000n),
    ], [commitment("a"), commitment("b")])).toBe(1);
  });

  test("returns null when a lifecycle position has no decryptable opening", () => {
    expect(walletMatchedVolumeUsd(
      [opening("a", 10_000_000n, 100_000_000n)],
      [commitment("a"), commitment("b")],
    )).toBeNull();
  });

  test("returns null for conflicting recovered payloads", () => {
    expect(walletMatchedVolumeUsd([
      opening("a", 10_000_000n, 100_000_000n),
      opening("a", 20_000_000n, 100_000_000n),
    ], [commitment("a")])).toBeNull();
  });

  test("returns zero for a wallet with no matched fills", () => {
    expect(walletMatchedVolumeUsd([], [])).toBe(0);
  });
});

function opening(label: string, size: bigint, entryPrice: bigint): WalletVolumeOpening {
  return {
    entryPrice: entryPrice.toString(),
    positionCommitment: commitment(label),
    size: size.toString(),
  };
}

function commitment(label: string): Hex {
  const byte = label.charCodeAt(0).toString(16).padStart(2, "0");
  return `0x${byte.repeat(32)}` as Hex;
}
