import { describe, expect, test } from "bun:test";
import { walletMatchedVolumeUsd, walletTradedVolumeUsd, type WalletVolumeOpening } from "@/lib/wallet-volume";
import type { Hex, ServerPortfolioSnapshot } from "@/types/trading";

describe("authoritative wallet traded volume", () => {
  test("uses confirmed lifetime notional despite unavailable open and closed position openings", () => {
    const portfolio = volumePortfolio({
      amount: "1257500000", status: "available", source: "pnlx-confirmed-fills",
    });
    expect(portfolio.positions.map((position) => position.status)).toEqual(["open", "closed"]);
    expect(walletTradedVolumeUsd(portfolio, [])).toBe(125.75);
  });

  test("converts protocol USDC units and preserves authoritative zero", () => {
    for (const [amount, expected] of [["0", 0], ["1", 0.0000001], ["10000000", 1], ["123456789", 12.3456789]] as const) {
      expect(walletTradedVolumeUsd(volumePortfolio({
        amount, status: "available", source: "pnlx-confirmed-fills",
      }), [opening("a", 10_000_000n, 250_000_000n), opening("b", 10_000_000n, 250_000_000n)])).toBe(expected);
    }
  });

  test("never falls back to a partial or conflicting local total when the server field is present", () => {
    const completeLocalHistory = [opening("a", 10_000_000n, 250_000_000n), opening("b", 10_000_000n, 250_000_000n)];
    for (const aggregate of [
      { amount: null, status: "incomplete", source: "pnlx-confirmed-fills" },
      { amount: "50000000", status: "incomplete", source: "pnlx-confirmed-fills" },
      null,
      undefined,
      {},
      [],
      "50000000",
      { amount: "50000000", status: "available", source: "other" },
    ]) {
      expect(walletTradedVolumeUsd(volumePortfolio(aggregate), completeLocalHistory)).toBeNull();
    }
  });

  test("rejects malformed, negative, fractional and non-finite available amounts", () => {
    for (const amount of [null, 50000000, "", "-1", "+1", "1.5", "1e7", " 10000000", "0x10", "01", "9".repeat(400)]) {
      expect(walletTradedVolumeUsd(volumePortfolio({
        amount, status: "available", source: "pnlx-confirmed-fills",
      }), [])).toBeNull();
    }
  });

  test("uses decrypted history only for legacy responses without the aggregate field", () => {
    const { positions } = volumePortfolio(undefined);
    const portfolio = { positions };
    const fills = [opening("a", 10_000_000n, 250_000_000n), opening("b", 5_000_000n, 100_000_000n)];
    expect(walletTradedVolumeUsd(portfolio, fills)).toBe(3);
    expect(walletTradedVolumeUsd(portfolio, fills.slice(0, 1))).toBeNull();
    expect(walletTradedVolumeUsd({ positions: [] }, [])).toBe(0);
  });
});

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

function volumePortfolio(tradedVolume: unknown): Pick<ServerPortfolioSnapshot, "positions" | "tradedVolume"> {
  return {
    positions: [
      { positionCommitment: commitment("a"), status: "open" },
      { positionCommitment: commitment("b"), status: "closed" },
    ],
    tradedVolume,
  } as Pick<ServerPortfolioSnapshot, "positions" | "tradedVolume">;
}
