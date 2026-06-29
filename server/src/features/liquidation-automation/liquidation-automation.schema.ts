import { parseProvenLiquidation } from "../liquidations/liquidations.schema";
import type { EnqueueLiquidationJobInput, RunLiquidationAutomationInput } from "./liquidation-automation.model";

type Body = Record<string, unknown>;

export function parseEnqueueLiquidationJob(input: Body): EnqueueLiquidationJobInput {
  return {
    liquidation: parseProvenLiquidation(requiredObject(input.liquidation ?? input, "liquidation")),
  };
}

export function parseRunLiquidationAutomation(input: Body): RunLiquidationAutomationInput {
  return {
    marketId: typeof input.marketId === "string" && input.marketId ? input.marketId : undefined,
  };
}

function requiredObject(value: unknown, field: string): Body {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as Body;
}
