import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { ConditionalOrdersController } from "@/features/conditional-orders/conditional-orders.controller";
import { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";

export function registerConditionalOrdersRoute(
  router: Router,
  executor: ExecutorService,
  prover: ProverService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
  options: { witnessRoutesEnabled?: boolean } = {},
): void {
  const controller = new ConditionalOrdersController(
    new ConditionalOrdersService(executor, prover, env, onchain),
  );
  router.add("POST", "/conditional-orders", (request) => controller.register(request));
  router.add("POST", "/conditional-orders/trigger-proven", (request) =>
    controller.triggerProven(request)
  );
  if (options.witnessRoutesEnabled) {
    router.add("POST", "/conditional-orders/trigger", (request) => controller.trigger(request));
    router.add("POST", "/conditional-orders/execute", (request) => controller.execute(request));
  }
}
