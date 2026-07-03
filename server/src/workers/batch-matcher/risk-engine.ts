import { hasInitialMargin, hasMaxLeverage, maintenanceMargin } from "@pnlx/market-math";
import type { MarketConfig } from "@pnlx/protocol-types";

export interface FillRiskInput {
  margin: bigint;
  market: MarketConfig;
  price: bigint;
  size: bigint;
}

export class MatchRiskEngine {
  assertFill(input: FillRiskInput): void {
    if (!hasInitialMargin(input.size, input.price, input.margin, input.market.initialMarginRate)) {
      throw new Error("insufficient initial margin");
    }
    if (!hasMaxLeverage(input.size, input.price, input.margin, input.market.maxLeverage)) {
      throw new Error("max leverage exceeded");
    }
    if (input.margin <= maintenanceMargin(input.size, input.price, input.market.maintenanceMarginRate)) {
      throw new Error("insufficient maintenance buffer");
    }
  }
}
