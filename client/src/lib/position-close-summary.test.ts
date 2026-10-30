import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PnlModal } from "@/components/pnl-modal";
import { summarizePositionCloses } from "@/lib/position-close-summary";
import type { ClosePositionResult } from "@/lib/position-close";
import type { PositionRow } from "@/types/trading";

const leg = (size: number, entryPrice: number, collateral: number, entryFee = 0) =>
  ({ size, entryPrice, collateral, entryFee }) as PositionRow;
const close = (markPrice: bigint, grossPricePnl: number, returnedMargin: number,
  fundingPayment = 0, fee = 0) => ({ markPrice, settlement: { grossPricePnl, returnedMargin, fundingPayment, fee } }) as ClosePositionResult;

describe("combined position close summary", () => {
  test("weights both entry and exit prices by each confirmed fill's size", () => {
    const summary = summarizePositionCloses([leg(100, 0.2, 10), leg(300, 0.24, 30)],
      [close(25_000_000n, 5, 15), close(27_000_000n, 9, 39)]);
    expect(summary.size).toBe(400);
    expect(summary.entryPrice).toBeCloseTo(0.23);
    expect(summary.closePrice).toBeCloseTo(0.265);
    expect(summary.grossPricePnl).toBe(14);
    expect(summary.returnedMargin).toBe(54);
    expect(summary.initialMargin).toBe(40);
  });

  test("counts paid entry fees, rebates and funding once using actual settlement totals", () => {
    const summary = summarizePositionCloses([leg(100, 0.2, 9.9, 0.1), leg(100, 0.2, 10.05, -0.05)],
      [close(20_000_000n, 0, 9.6, 0.2, 0.1), close(20_000_000n, 0, 10.15, -0.1)]);
    expect(summary.initialMargin).toBeCloseTo(20);
    expect(summary.fee).toBeCloseTo(0.15);
    expect(summary.fundingPayment).toBeCloseTo(0.1);
    expect(summary.returnedMargin).toBeCloseTo(19.75);
  });

  test("rejects partial groups and missing prices instead of fabricating a whole-trade result", () => {
    expect(() => summarizePositionCloses([], [])).toThrow("incomplete");
    expect(() => summarizePositionCloses([leg(1, 0.2, 1), leg(1, 0.2, 1)], [close(20_000_000n, 0, 1)]))
      .toThrow("incomplete");
    for (const size of [undefined, NaN, Infinity, 0]) {
      expect(() => summarizePositionCloses([{ ...leg(1, 0.2, 1), size }], [close(20_000_000n, 0, 1)]))
        .toThrow("unavailable");
    }
  });

  test("displays confirmed wallet gain when a paired payout caps theoretical price profit", () => {
    const summary = summarizePositionCloses([leg(100, 0.2, 10)], [close(60_000_000n, 40, 20)]);
    const markup = renderToStaticMarkup(createElement(PnlModal, {
      ...summary, isOpen: true, marketId: "xlm-usd-perp", side: "long", onClose: () => undefined,
    }));
    expect(markup).toContain("+$10.00");
    expect(markup).not.toContain("+$40.00");
  });
});
