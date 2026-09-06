/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { pnlShareCardContent } from "@/lib/pnl-share-card";

describe("PNL card sharing", () => {
  test("builds the values rendered into the shared image", () => {
    const content = pnlShareCardContent({
      closePrice: 0.1612,
      entryPrice: 0.1594,
      marketId: "xlm-usd-perp",
      netRealizedPnl: 42.8,
      pnlPercent: 12.4,
      side: "long",
      txHash: "0x7e897199956b77aa908bf4a437baa41ff464909ec155b5fd93a9e5c28a306763",
    });

    expect(content).toEqual({
      entry: "0.1594",
      exit: "0.1612",
      fileName: "pnlx-xlm-pnl.png",
      market: "XLM/USD",
      pnl: "+$42.80",
      pnlPercent: "+12.40%",
      side: "Long · Market",
      txHash: "7E89...6763",
    });
  });

  test("supports a negative card without a settlement hash", () => {
    const content = pnlShareCardContent({
      closePrice: 0.16,
      entryPrice: 0.17,
      marketId: "xlm-usd-perp",
      netRealizedPnl: -3.25,
      side: "short",
    });

    expect(content.pnl).toBe("−$3.25");
    expect(content.side).toBe("Short · Market");
    expect(content.txHash).toBeUndefined();
  });
});
