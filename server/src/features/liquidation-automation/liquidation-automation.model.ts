import type { LiquidationAutomationJobRecord, LiquidationRecord } from "@pnlx/protocol-types";

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
