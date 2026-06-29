import type { LiquidationAutomationJobRecord, LiquidationRecord } from "@merkl/protocol-types";

export interface EnqueueLiquidationJobInput {
  liquidation: LiquidationRecord;
}

export interface RunLiquidationAutomationInput {
  marketId?: string;
  now?: number;
}

export interface LiquidationAutomationJobResult {
  job: LiquidationAutomationJobRecord;
  reason?: string;
  status: LiquidationAutomationJobRecord["status"];
}

export interface LiquidationAutomationRunResult {
  completedAt: number;
  jobs: LiquidationAutomationJobResult[];
  startedAt: number;
}
