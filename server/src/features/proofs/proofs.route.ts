import type { Router } from "../../shared/http/router";
import type { ProverService } from "../../workers/prover/prover.service";
import { ProofsController } from "./proofs.controller";
import { ProofsService } from "./proofs.service";

export function registerProofsRoute(
  router: Router,
  prover: ProverService,
  options: { witnessRoutesEnabled?: boolean } = {},
): void {
  const controller = new ProofsController(new ProofsService(prover));
  router.add("GET", "/proofs/verifiers", () => controller.verifiers());
  router.add("POST", "/proofs/artifacts", (request) => controller.registerArtifact(request));
  if (options.witnessRoutesEnabled) {
    router.add("POST", "/proofs/intent", (request) => controller.intent(request));
    router.add("POST", "/proofs/liquidation", (request) => controller.liquidation(request));
    router.add("POST", "/proofs/disclosure", (request) => controller.disclosure(request));
  }
}
