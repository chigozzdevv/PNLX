import type { Router } from "@/shared/http/router";
import { LiquidationAutomationController } from "@/features/liquidation-automation/liquidation-automation.controller";
import type { LiquidationAutomationService } from "@/features/liquidation-automation/liquidation-automation.service";

export function registerLiquidationAutomationRoute(
  router: Router,
  automation: LiquidationAutomationService,
): void {
  const controller = new LiquidationAutomationController(automation);
  router.add("GET", "/liquidation-automation/jobs", () => controller.list(), { auth: true });
  router.add("POST", "/liquidation-automation/jobs", (request) => controller.enqueue(request));
  router.add("POST", "/liquidation-automation/run", (request) => controller.run(request));
}
