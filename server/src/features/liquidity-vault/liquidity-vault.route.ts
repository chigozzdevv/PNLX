import type { Router } from "@/shared/http/router";
import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import { LiquidityVaultController } from "@/features/liquidity-vault/liquidity-vault.controller";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";

export function registerLiquidityVaultRoute(
  router: Router,
  relayer: Pick<RelayerService, "readAsync" | "prepareXdr">,
  deployment?: DeploymentRegistry,
): void {
  const controller = new LiquidityVaultController(new LiquidityVaultService(relayer, deployment));
  router.add("GET", "/liquidity-vault", () => controller.status());
  router.add("GET", "/liquidity-vault/account", (request) => controller.account(request), { auth: true });
  router.add("POST", "/liquidity-vault/prepare", (request) => controller.prepare(request));
}
