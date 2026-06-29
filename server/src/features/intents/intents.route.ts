import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { IntentsController } from "@/features/intents/intents.controller";
import { IntentsService } from "@/features/intents/intents.service";

export function registerIntentsRoute(
  router: Router,
  executor: ExecutorService,
  prover: ProverService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
  options: { witnessRoutesEnabled?: boolean } = {},
): void {
  const controller = new IntentsController(new IntentsService(executor, prover, onchain, env));
  router.add("POST", "/intents/shared", (request) => controller.createShared(request));
  if (options.witnessRoutesEnabled) {
    router.add("POST", "/intents", (request) => controller.create(request));
    router.add("POST", "/intents/prove-and-submit", (request) => controller.proveAndSubmit(request));
  }
}
