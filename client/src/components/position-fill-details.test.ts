import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PortfolioRecords } from "@/components/portfolio-records";
import { PositionsTable } from "@/components/positions-table";
import { PositionFillDetails } from "@/components/position-fill-details";
import { groupPositionRows } from "@/lib/position-groups";
import type { Hex, MarketDisplay, PositionRow, ServerOwnerOrderSnapshot } from "@/types/trading";

const hex = (value: number): Hex => `0x${value.toString(16).padStart(64, "0")}`;
const firstOrder = order(1, "ui-1730000000000-request-1");
const secondOrder = order(2, "ui-1730000000000-request-2");
const residual = { ...order(3, "residual"), isResidual: true, sourceIntentCommitment: secondOrder.intentCommitment };
const orders = [firstOrder, secondOrder, residual];
const positions = [fill(1, firstOrder.intentCommitment, 10, 1, 0.1), fill(2, residual.intentCommitment, 30, 3, 0.2)];

describe("combined position presentation", () => {
  test("shows the first fill liquidation estimate in both rows and each independent fill detail", () => {
    const market = { marketId: "xlm-usd-perp", maintenanceMarginRate: 0.05, fundingIndex: "0" } as MarketDisplay;
    for (const markup of [renderToStaticMarkup(createElement(PositionsTable, {
      connected: true, onConnect: async () => undefined, markets: [market], orders, positions,
    })), renderToStaticMarkup(createElement(PortfolioRecords, { activity: [], markets: [market], orders, positions }))]) {
      expect(markup).toContain("Est. liq. $0.2000");
      expect(markup).not.toContain("Liq. —");
    }
    const [position] = groupPositionRows(positions, orders);
    const details = renderToStaticMarkup(createElement(PositionFillDetails, {
      className: "portfolio-detail-panel", id: "risk", market, orders, position,
    }));
    const sections = details.match(/<section\b[^>]*>[\s\S]*?<\/section>/g)!;
    expect(sections[0]).toContain("$0.09473685");
    expect(sections[1]).toContain("$0.2000");
    expect(details.match(/<dt>Est\. liq\.<\/dt>/g)).toHaveLength(2);
  });

  test("shows one aggregate trade in both records views", () => {
    const trade = renderToStaticMarkup(createElement(PositionsTable, {
      connected: true, onConnect: async () => undefined, orders, positions,
    }));
    const portfolio = renderToStaticMarkup(createElement(PortfolioRecords, { activity: [], orders, positions }));
    for (const markup of [trade, portfolio]) {
      expect(markup).toContain("Positions 1");
      expect(markup.match(/>More details<\/span>/g)).toHaveLength(1);
      expect(markup).toMatch(/40(?:\.000000)? XLM/);
      expect(markup).toContain("$4.00");
      expect(markup).toContain("$0.1750 → $0.2500");
      expect(markup).toContain("+$2.00");
    }
  });

  test("retains each fill's amounts, time and its own order/proof/settlement links", () => {
    const [position] = groupPositionRows(positions, orders);
    const markup = renderToStaticMarkup(createElement(PositionFillDetails, {
      className: "trade-records-details", id: "fills", orders, position,
    }));
    const sections = markup.match(/<section\b[^>]*>[\s\S]*?<\/section>/g)!;
    expect(sections).toHaveLength(2);
    for (const [index, section] of sections.entries()) {
      const fill = positions[index];
      expect(section).toContain(`Fill ${index + 1}`);
      expect(section).toContain(`${fill.size} XLM`);
      expect(section).toContain(`$${fill.collateral}.00`);
      expect(section).toContain(index === 0 ? "$0.1000" : "$0.2000");
      expect(section).toContain(new Date(fill.openedAt).toISOString());
      for (const hash of [orders[index].submissionTxHash!, fill.proofVerificationTxHash!, fill.settlementTxHash!]) {
        expect(section).toContain(`href="https://stellar.expert/explorer/testnet/tx/${hash.slice(2)}"`);
      }
      expect(section).toContain(`Prover job`);
      expect(section).toContain(fill.proverJobId!);
      expect(section).toContain(fill.batchId);
      expect(section).not.toContain(positions[1 - index].settlementTxHash!);
      expect(section).not.toContain(fill.privateState!.positionNullifier);
    }
    // A residual's execution batch is not the user's original submission.
    expect(markup).not.toContain(`title="${residual.submissionTxHash}"`);
  });

  test("keeps a shielded fill distinct without inventing zero amounts or an unrelated order link", () => {
    const hidden: PositionRow = { ...positions[1], sourceIntentCommitment: hex(999),
      size: undefined, collateral: undefined, entryPrice: undefined, fundingPayment: undefined,
      privateState: undefined, privateDetails: true };
    const markup = renderToStaticMarkup(createElement(PositionFillDetails, {
      className: "portfolio-detail-panel", id: "hidden", orders, position: hidden,
    }));
    expect(markup.match(/>Shielded<\/dd>/g)).toHaveLength(4);
    for (const field of ["Size", "Margin", "Entry", "Funding"]) {
      expect(markup).toContain(`<dt>${field}</dt><dd>Shielded</dd>`);
    }
    expect(markup).not.toContain("$0.00");
    expect(markup).not.toContain("Order submission for fill");
    expect(markup).toContain(hidden.settlementTxHash!);
  });
});

function order(index: number, batchId: string): ServerOwnerOrderSnapshot {
  return {
    batchId, createdAt: 1_730_000_000_000, updatedAt: 1_730_000_000_000,
    intentCommitment: hex(index), isResidual: false, marketId: "xlm-usd-perp",
    matching: { message: "Settled", state: "settled" }, matchingPayloadCommitment: hex(10 + index),
    status: "filled", submissionTxHash: hex(20 + index),
  };
}

function fill(index: number, sourceIntentCommitment: Hex, size: number, collateral: number, entryPrice: number): PositionRow {
  return {
    batchId: `execution-${index}`, closePrice: null, collateral, commitment: hex(30 + index), entryPrice,
    id: hex(30 + index), market: "XLM/USD", marketId: "xlm-usd-perp", marketPrice: 0.25,
    openedAt: 1_730_000_000_000 + index * 1_000, side: "long", size, sourceIntentCommitment,
    status: "open", time: "", unrealizedPnl: index === 1 ? 0.5 : 1.5,
    proofVerificationTxHash: hex(40 + index), settlementTxHash: hex(50 + index),
    proverJobId: `job-${60 + index}`, proofSystem: index === 1 ? "risc0-groth16" : "noir-ultrahonk",
    privateState: {
      entryPrice: `${entryPrice * 100_000_000}`, fundingIndex: "0", margin: `${collateral * 10_000_000}`,
      positionNullifier: hex(70 + index), side: "long", size: `${size * 100_000_000}`, sourceIntentCommitment,
    },
  };
}
