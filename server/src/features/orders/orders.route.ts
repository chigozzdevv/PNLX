import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { OrdersController } from "@/features/orders/orders.controller";
import { OrdersService } from "@/features/orders/orders.service";

export function registerOrdersRoute(
  router: Router,
  executor: ExecutorService,
  prover: ProverService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
  options: { witnessRoutesEnabled?: boolean } = {},
): void {
  const controller = new OrdersController(new OrdersService(executor, prover, onchain, env));
  router.add("POST", "/orders/cancel", (request) => controller.cancel(request));
  if (options.witnessRoutesEnabled) {
    router.add("POST", "/orders/replace", (request) => controller.replace(request));
  }
}
