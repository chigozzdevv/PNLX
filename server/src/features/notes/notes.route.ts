import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import { NotesController } from "@/features/notes/notes.controller";
import { NotesService } from "@/features/notes/notes.service";

export function registerNotesRoute(
  router: Router,
  executor: ExecutorService,
  prover: ProverService,
  env: ServerEnv,
  onchain?: OnchainRelayService,
  relayer?: RelayerService,
): void {
  const controller = new NotesController(new NotesService(executor, prover, env, onchain, relayer));
  router.add("GET", "/notes/membership", (request) => controller.membership(request), { auth: true });
  router.add("POST", "/notes/deposit-asset/prepare-proven", (request) =>
    controller.prepareDepositAssetProven(request),
  );
  router.add("POST", "/notes/deposit-asset/proven", (request) => controller.depositAssetProven(request));
  router.add("POST", "/notes/deposit-asset/finalize", (request) =>
    controller.finalizeDepositAsset(request),
  );
  router.add("POST", "/notes/withdraw/proven", (request) => controller.withdrawProven(request));
  router.add("POST", "/notes/withdraw-asset/proven", (request) => controller.withdrawAssetProven(request));
  if (env.serverWitnessRoutesEnabled) {
    router.add("POST", "/notes/deposit", (request) => controller.deposit(request));
    router.add("POST", "/notes/deposit-asset/prepare", (request) =>
      controller.prepareDepositAsset(request),
    );
    router.add("POST", "/notes/deposit-asset", (request) => controller.depositAsset(request));
    router.add("POST", "/notes/withdraw", (request) => controller.withdraw(request));
    router.add("POST", "/notes/withdraw-asset", (request) => controller.withdrawAsset(request));
  }
}
