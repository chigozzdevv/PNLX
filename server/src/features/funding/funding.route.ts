import type { Router } from "../../shared/http/router";
import type { ServerEnv } from "../../config/env";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type { FundingEngineService } from "../../workers/funding-engine/funding-engine.service";
import { FundingController } from "./funding.controller";
import { FundingService } from "./funding.service";

export function registerFundingRoute(
  router: Router,
  executor: ExecutorService,
  env: ServerEnv,
  engine?: FundingEngineService,
): void {
  const controller = new FundingController(new FundingService(executor, env, engine));
  router.add("GET", "/funding", () => controller.list());
  router.add("POST", "/funding/advance", (request) => controller.advance(request));
  router.add("POST", "/funding/run", (request) => controller.run(request));
}
