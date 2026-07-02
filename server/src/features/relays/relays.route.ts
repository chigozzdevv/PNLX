import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { RelaysController } from "@/features/relays/relays.controller";
import { RelaysService } from "@/features/relays/relays.service";

export function registerRelaysRoute(
  router: Router,
  relayer: RelayerService,
  env: ServerEnv,
  executor?: Pick<ExecutorService, "store">,
): void {
  const controller = new RelaysController(new RelaysService(relayer, env, executor));
  router.add("GET", "/relays", () => controller.list());
  router.add("POST", "/relays", (request) => controller.create(request));
  router.add("POST", "/relays/signed-xdr", (request) => controller.submitSignedXdr(request));
}
