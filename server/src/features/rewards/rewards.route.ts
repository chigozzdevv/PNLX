import type { Router } from "@/shared/http/router";
import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import type { ProtocolStore } from "@/shared/state/store";
import type { ServerEnv } from "@/config/env";
import { RewardsController } from "@/features/rewards/rewards.controller";
import { RewardsService } from "@/features/rewards/rewards.service";
import { ReferralRegistry } from "@/features/rewards/rewards.referrals";
import { RewardRequestRegistry } from "@/features/rewards/rewards.requests";

export function registerRewardsRoute(router: Router, relayer: RelayerService, store: ProtocolStore,
  env: Pick<ServerEnv, "mongodbUri" | "mongodbDatabase" | "makerWalletAddress">,
  deployment?: DeploymentRegistry): void {
  const referrals = new ReferralRegistry(env.mongodbUri ? { uri: env.mongodbUri, database: env.mongodbDatabase } : undefined);
  const requests = new RewardRequestRegistry(env.mongodbUri ? { uri: env.mongodbUri, database: env.mongodbDatabase } : undefined);
  const controller = new RewardsController(new RewardsService(relayer, store, referrals, env.makerWalletAddress, deployment, requests));
  router.add("GET", "/rewards", (request) => controller.account(request), { auth: true });
  router.add("POST", "/rewards/prepare-claim", (request) => controller.prepareClaim(request), { auth: true });
  router.add("POST", "/rewards/referral", (request) => controller.registerReferral(request), { auth: true });
}
