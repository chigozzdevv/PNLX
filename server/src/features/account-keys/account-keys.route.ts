import type { Router } from "../../shared/http/router";
import type { ExecutorService } from "../../workers/executor/executor.service";
import { AccountKeysController } from "./account-keys.controller";
import { AccountKeysService } from "./account-keys.service";

export function registerAccountKeysRoute(router: Router, executor: ExecutorService): void {
  const controller = new AccountKeysController(new AccountKeysService(executor));
  router.add("GET", "/account-keys", (request) => controller.get(request), { auth: true });
  router.add("POST", "/account-keys", (request) => controller.upsert(request));
}
