import type { Router } from "@/shared/http/router";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { AccountKeysController } from "@/features/account-keys/account-keys.controller";
import { AccountKeysService } from "@/features/account-keys/account-keys.service";
import type { LegacyExitRecoveryService } from "@/features/notes/legacy-exit-recovery";

export function registerAccountKeysRoute(router: Router, executor: ExecutorService, legacyExitRecovery?: LegacyExitRecoveryService): void {
  const controller = new AccountKeysController(new AccountKeysService(executor, legacyExitRecovery));
  router.add("GET", "/account-keys", (request) => controller.get(request), { auth: true });
  router.add("POST", "/account-keys", (request) => controller.upsert(request));
  router.add("POST", "/account-keys/recover", (request) => controller.recover(request), { auth: true });
}
