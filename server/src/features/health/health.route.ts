import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import { HealthController } from "@/features/health/health.controller";

export function registerHealthRoute(
  router: Router,
  env: ServerEnv,
  onchain?: Pick<OnchainRelayService, "enabled" | "tokenDigest">,
): void {
  const controller = new HealthController(env, onchain);
  router.add("GET", "/health", () => controller.get());
}
