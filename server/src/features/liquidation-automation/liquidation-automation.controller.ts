import { json, readJson } from "@/shared/http/json";
import {
  parseEnqueueLiquidationJob,
  parseRunLiquidationAutomation,
} from "@/features/liquidation-automation/liquidation-automation.schema";
import type { LiquidationAutomationService } from "@/features/liquidation-automation/liquidation-automation.service";

export class LiquidationAutomationController {
  constructor(private readonly automation: LiquidationAutomationService) {}

  async enqueue(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ liquidationJob: this.automation.enqueue(parseEnqueueLiquidationJob(body)) }, 201);
  }

  list(): Response {
    return json({ liquidationJobs: this.automation.list() });
  }

  async run(request: Request): Promise<Response> {
    const body = await readOptionalJson(request);
    return json(this.automation.runOnce(parseRunLiquidationAutomation(body)), 201);
  }
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length === "0") return {};
  return await readJson<Record<string, unknown>>(request).catch(() => ({}));
}
