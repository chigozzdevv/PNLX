import type { Router } from "../../shared/http/router";
import type { ServerEnv } from "../../config/env";
import type { RelayerService } from "../../workers/relayer/relayer.service";
import { RelaysController } from "./relays.controller";
import { RelaysService } from "./relays.service";

export function registerRelaysRoute(router: Router, relayer: RelayerService, env: ServerEnv): void {
  const controller = new RelaysController(new RelaysService(relayer, env));
  router.add("GET", "/relays", () => controller.list());
  router.add("POST", "/relays", (request) => controller.create(request));
  router.add("POST", "/relays/signed-xdr", (request) => controller.submitSignedXdr(request));
}
