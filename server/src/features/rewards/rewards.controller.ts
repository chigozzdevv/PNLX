import { authenticatedAddress } from "@/shared/http/auth-context";
import { json, readJson } from "@/shared/http/json";
import { parseReferral, parseRewardClaim } from "@/features/rewards/rewards.schema";
import type { RewardsService } from "@/features/rewards/rewards.service";

export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  async account(request: Request): Promise<Response> {
    const owner = authenticatedAddress(request);
    if (!owner) return json({ error: "Connect your wallet to view rewards" }, 401);
    return json({ rewards: await this.rewards.account(owner) });
  }

  async prepareClaim(request: Request): Promise<Response> {
    const owner = authenticatedAddress(request);
    if (!owner) return json({ error: "Connect your wallet to claim rewards" }, 401);
    const kind = parseRewardClaim(await readJson<Record<string, unknown>>(request));
    return json({ transaction: await this.rewards.prepareClaim(owner, kind) }, 201);
  }

  async registerReferral(request: Request): Promise<Response> {
    const owner = authenticatedAddress(request);
    if (!owner) return json({ error: "Connect your wallet to register a referral" }, 401);
    const referrer = parseReferral(await readJson<Record<string, unknown>>(request));
    const attribution = await this.rewards.registerReferral(owner, referrer);
    return json({ registeredAt: attribution.registeredAt }, 201);
  }
}
