import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import { HealthController } from "@/features/health/health.controller";
import type { ProtocolPersistenceStatus } from "@/shared/state/mongo-store";

interface PersistenceStatusProvider {
  persistenceStatus(): ProtocolPersistenceStatus;
}

export function registerHealthRoute(
  router: Router,
  env: ServerEnv,
  onchain?: Pick<OnchainRelayService, "enabled" | "tokenDigest">,
  store?: unknown,
): void {
  const persistence = isPersistenceStatusProvider(store) ? store : undefined;
  const controller = new HealthController(env, onchain, persistence);
  router.add("GET", "/health", () => controller.get());
}

function isPersistenceStatusProvider(value: unknown): value is PersistenceStatusProvider {
  return Boolean(
    value &&
    typeof value === "object" &&
    "persistenceStatus" in value &&
    typeof value.persistenceStatus === "function",
  );
}
