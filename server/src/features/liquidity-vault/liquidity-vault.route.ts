import type { Router } from "@/shared/http/router";
import { LiquidityVaultController } from "@/features/liquidity-vault/liquidity-vault.controller";
import type { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import type { LiquidityVaultHistory } from "@/features/liquidity-vault/liquidity-vault.history";
import { json } from "@/shared/http/json";

export function registerLiquidityVaultRoute(
  router: Router,
  vault: LiquidityVaultService,
  history?: LiquidityVaultHistory,
): void {
  const controller = new LiquidityVaultController(vault);
  router.add("GET", "/liquidity-vault", () => controller.status());
  router.add("GET", "/liquidity-vault/account", (request) => controller.account(request), { auth: true });
  router.add("POST", "/liquidity-vault/prepare", (request) => controller.prepare(request));
  if (history) router.add("GET", "/liquidity-vault/history", async () => json(await history.history()));
}
