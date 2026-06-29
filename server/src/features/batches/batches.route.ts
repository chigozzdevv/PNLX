import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import { BatchesController } from "@/features/batches/batches.controller";
import { BatchesService } from "@/features/batches/batches.service";

export function registerBatchesRoute(
  router: Router,
  executor: ExecutorService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
): void {
  const controller = new BatchesController(
    new BatchesService(
      executor,
      onchain,
      env.protocolAdminAddresses,
      env.protocolAdminRequired,
      env,
    ),
  );
  router.add("POST", "/batches/settle", (request) => controller.settle(request));
  router.add("POST", "/batches/settle-external", (request) => controller.settleExternal(request));
}
