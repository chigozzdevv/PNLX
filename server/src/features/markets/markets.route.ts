import type { Router } from "../../shared/http/router";
import type { ServerEnv } from "../../config/env";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type { OnchainRelayService } from "../../workers/onchain/onchain.service";
import type { OracleService } from "../../workers/oracle/oracle.service";
import { MarketsController } from "./markets.controller";
import { MarketsService } from "./markets.service";

export function registerMarketsRoute(
  router: Router,
  executor: ExecutorService,
  oracle: OracleService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
): void {
  const controller = new MarketsController(new MarketsService(executor, oracle, env, onchain));
  router.add("GET", "/markets", () => controller.list());
  router.add("POST", "/markets", (request) => controller.create(request));
  router.add("POST", "/markets/update", (request) => controller.update(request));
  router.add("POST", "/markets/oracle", (request) => controller.createFromOracle(request));
  router.add("POST", "/markets/oracle/refresh", (request) => controller.refreshFromOracle(request));
}
