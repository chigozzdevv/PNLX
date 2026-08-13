import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PositionsTable } from "@/components/positions-table";
import type {
  PositionRow,
  ServerOwnerActivitySnapshot,
  ServerOwnerOrderSnapshot,
} from "@/types/trading";

const intentCommitment = `0x${"1".repeat(64)}` as const;
const positionCommitment = `0x${"2".repeat(64)}` as const;

const position: PositionRow = {
  batchId: "batch-1",
  closePrice: null,
  collateral: 50,
  entryPrice: 0.15,
  id: positionCommitment,
  market: "XLM/USD",
  marketId: "xlm-usd-perp",
  marketPrice: 0.16,
  openedAt: Date.UTC(2026, 7, 13, 9, 0),
  privateDetails: true,
  privateState: {
    entryPrice: "15000000",
    fundingIndex: "0",
    margin: "50000000",
    positionNullifier: `0x${"3".repeat(64)}`,
    side: "long",
    size: "30000000000",
    sourceIntentCommitment: intentCommitment,
  },
  side: "long",
  size: 300,
  sourceIntentCommitment: intentCommitment,
  status: "open",
  time: "09:00",
  unrealizedPnl: 3,
};

const order: ServerOwnerOrderSnapshot = {
  batchId: "batch-1",
  createdAt: Date.UTC(2026, 7, 13, 8, 58),
  intentCommitment,
  isResidual: false,
  marketId: "xlm-usd-perp",
  matching: { message: "Queued for matching", state: "queued" },
  matchingPayloadCommitment: `0x${"4".repeat(64)}`,
  status: "open",
  updatedAt: Date.UTC(2026, 7, 13, 8, 59),
};

const activity: ServerOwnerActivitySnapshot = {
  batchId: "batch-1",
  id: positionCommitment,
  kind: "position",
  marketId: "xlm-usd-perp",
  proofDigest: `0x${"5".repeat(64)}`,
  proofSystem: "risc0-groth16",
  status: "open",
  timestamp: Date.UTC(2026, 7, 13, 9, 0),
  updatedAt: Date.UTC(2026, 7, 13, 9, 0),
};

describe("PositionsTable", () => {
  test("shows concise position rows with Close and a details disclosure", () => {
    const html = renderToStaticMarkup(
      <PositionsTable
        activity={[activity]}
        onClosePosition={() => undefined}
        orders={[order]}
        positions={[position]}
      />,
    );

    expect(html).toContain("Positions 1");
    expect(html).toContain("Orders 1");
    expect(html).toContain("Activity 1");
    expect(html).toContain("Entry → mark");
    expect(html).toContain("More details");
    expect(html).toContain(">Close<");
    expect(html).not.toContain("Liq.");
    expect(html).not.toContain(">Proof<");
  });

  test("keeps Cancel available in the Orders view without a visible origin column", () => {
    const html = renderToStaticMarkup(
      <PositionsTable activeView="orders" orders={[order]} positions={[position]} />,
    );

    expect(html).toContain(">Cancel<");
    expect(html).toContain("More details");
    expect(html).not.toContain(">Origin<");
    expect(html).not.toContain("Proof");
  });

  test("shows why a position without its local key cannot be closed", () => {
    const html = renderToStaticMarkup(
      <PositionsTable positions={[{ ...position, privateState: undefined }]} />,
    );

    expect(html).toContain(">Key unavailable<");
    expect(html).not.toContain(">Close<");
  });
});
