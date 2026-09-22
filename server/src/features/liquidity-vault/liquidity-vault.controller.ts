import { authenticatedAddress, assertAuthenticatedAccount } from "@/shared/http/auth-context";
import { json, readJson } from "@/shared/http/json";
import { parsePrepareVault } from "@/features/liquidity-vault/liquidity-vault.schema";
import type { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";

export class LiquidityVaultController {
  constructor(private readonly vault: LiquidityVaultService) {}

  async status(): Promise<Response> {
    return json({ vault: await this.vault.status() });
  }

  async account(request: Request): Promise<Response> {
    const owner = new URL(request.url).searchParams.get("owner");
    if (!owner) throw new Error("owner is required");
    assertAuthenticatedAccount(authenticatedAddress(request), owner, "owner");
    return json({ account: await this.vault.account(owner) });
  }

  async prepare(request: Request): Promise<Response> {
    const input = parsePrepareVault(await readJson<Record<string, unknown>>(request));
    assertAuthenticatedAccount(authenticatedAddress(request), input.owner, "owner");
    return json({ transaction: this.vault.prepare(input.owner, input.action) }, 201);
  }
}
