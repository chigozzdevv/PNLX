import type { Router } from "@/shared/http/router";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { AccountEventsController } from "@/features/account-events/account-events.controller";
import { AccountEventsService } from "@/features/account-events/account-events.service";

export function registerAccountEventsRoute(router: Router, executor: ExecutorService): void {
  const controller = new AccountEventsController(new AccountEventsService(executor));
  router.add("GET", "/account-events", (request) => controller.list(request), { auth: true });
  router.add("POST", "/account-events", (request) => controller.create(request));
}
