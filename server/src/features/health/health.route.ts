import type { Router } from "../../shared/http/router";
import type { ServerEnv } from "../../config/env";
import { HealthController } from "./health.controller";

export function registerHealthRoute(router: Router, env: ServerEnv): void {
  const controller = new HealthController(env);
  router.add("GET", "/health", () => controller.get());
}
