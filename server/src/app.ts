import { registerAccountKeysRoute } from "./features/account-keys/account-keys.route";
import { registerAccountEventsRoute } from "./features/account-events/account-events.route";
import { registerAuthRoute } from "./features/auth/auth.route";
import { registerBatchesRoute } from "./features/batches/batches.route";
import { registerConditionalOrdersRoute } from "./features/conditional-orders/conditional-orders.route";
import { registerDisclosuresRoute } from "./features/disclosures/disclosures.route";
import { registerFundingRoute } from "./features/funding/funding.route";
import { registerHealthRoute } from "./features/health/health.route";
import { registerIntentsRoute } from "./features/intents/intents.route";
import { registerLiquidationsRoute } from "./features/liquidations/liquidations.route";
import { registerMarketsRoute } from "./features/markets/markets.route";
import { registerNotesRoute } from "./features/notes/notes.route";
import { registerOrdersRoute } from "./features/orders/orders.route";
import { registerPositionClosesRoute } from "./features/position-closes/position-closes.route";
import { registerPortfolioRoute } from "./features/portfolio/portfolio.route";
import { registerProofsRoute } from "./features/proofs/proofs.route";
import { registerRelaysRoute } from "./features/relays/relays.route";
import { loadEnv } from "./config/env";
import { Router } from "./shared/http/router";
import { AuthService } from "./features/auth/auth.service";
import { createExecutor } from "./workers/executor/executor.worker";
import { createBatchExecutor } from "./workers/batch-executor/batch-executor.worker";
import type { BatchExecutorService } from "./workers/batch-executor/batch-executor.service";
import { createExternalMatcher } from "./workers/external-matcher/external-matcher.worker";
import { RemoteExternalMatcherClient } from "./workers/external-matcher/remote-external-matcher.service";
import { createFundingEngine } from "./workers/funding-engine/funding-engine.worker";
import type { FundingEngineService } from "./workers/funding-engine/funding-engine.service";
import { OracleService } from "./workers/oracle/oracle.service";
import { loadDeploymentRegistry } from "./workers/onchain/deployment";
import { createOnchainRelay } from "./workers/onchain/onchain.worker";
import { createProver } from "./workers/prover/prover.worker";
import { createRelayer } from "./workers/relayer/relayer.worker";

export interface AppRuntime {
  batchExecutor: BatchExecutorService;
  fundingEngine: FundingEngineService;
  router: Router;
}

export function createApp(): Router {
  return createAppRuntime().router;
}

export function createAppRuntime(): AppRuntime {
  const env = loadEnv();
  const auth = new AuthService(env.stellarNetworkPassphrase, env.authStorePath || undefined);
  const router = new Router({
    authenticate: (request) => auth.authenticateRequest(request),
    protectMutations: env.authRequired,
  });
  const executor = createExecutor({
    matchingBackend: env.matchingBackend,
    mpcNodeIds: env.mpcNodeIds,
    mpcThreshold: env.mpcThreshold,
    privateMatchingRequired: env.privateMatchingRequired,
    storePath: env.protocolStorePath || undefined,
  });
  const prover = createProver();
  const deployment = env.stellarOnchainRelay
    ? loadDeploymentRegistry(env.stellarDeploymentFile)
    : undefined;
  const oracle = new OracleService({
    hermesUrl: env.pythHermesUrl,
    marketContractId: deployment?.contracts.market,
    maxAgeSeconds: env.oraclePriceMaxAgeSeconds,
    maxConfidenceBps: env.oracleMaxConfidenceBps,
    network: env.stellarNetwork,
    networkPassphrase: env.stellarNetworkPassphrase,
    priceSource: env.oraclePriceSource,
    rpcUrl: env.stellarRpcUrl,
    source: env.stellarSource,
  });
  const relayer = createRelayer({
    config: {
      mode: env.stellarRelayerMode === "stellar-cli" ? "stellar-cli" : "local",
      network: env.stellarNetwork,
      networkPassphrase: env.stellarNetworkPassphrase,
      rpcUrl: env.stellarRpcUrl,
      source: env.stellarSource,
    },
    historyPath: env.relayStorePath || undefined,
  });
  const onchain = env.stellarOnchainRelay
    ? createOnchainRelay(relayer, {
        deployment,
        enabled: true,
        resolveProofArtifact: (proof) => prover.artifactFor(proof) ?? executor.artifactFor(proof),
      })
    : undefined;
  const fundingEngine = createFundingEngine(
    executor,
    {
      intervalMs: env.fundingIntervalMs,
      maxFundingDelta: env.fundingMaxDelta,
      premiumRate: env.fundingPremiumRate,
      settlementsOnchainRequired: env.settlementsOnchainRequired,
    },
    prover,
    onchain,
  );
  if (env.privateMatchingRequired && env.matchingBackend === "external-blind" && !env.externalMatcherUrl) {
    throw new Error("EXTERNAL_MATCHER_URL is required for private external matching");
  }
  const externalMatcher = env.externalMatcherUrl
    ? new RemoteExternalMatcherClient({
        token: env.externalMatcherToken || undefined,
        url: env.externalMatcherUrl,
      })
    : createExternalMatcher(executor);
  const batchExecutor = createBatchExecutor(
    executor,
    externalMatcher,
    {
      batchIdPrefix: env.batchExecutorPrefix,
      intervalMs: env.batchExecutorIntervalMs,
      settlementsOnchainRequired: env.settlementsOnchainRequired,
    },
    onchain,
  );

  registerAuthRoute(router, auth);
  registerHealthRoute(router, env);
  registerAccountKeysRoute(router, executor);
  registerAccountEventsRoute(router, executor);
  registerPortfolioRoute(router, executor);
  registerNotesRoute(router, executor, prover, env, onchain, relayer);
  registerMarketsRoute(router, executor, oracle, env, onchain);
  registerFundingRoute(router, executor, env, fundingEngine);
  registerIntentsRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerOrdersRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerBatchesRoute(router, executor, env, onchain);
  registerProofsRoute(router, prover, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerRelaysRoute(router, relayer, env);
  registerLiquidationsRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerConditionalOrdersRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerPositionClosesRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerDisclosuresRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });

  if (env.fundingEngineEnabled) {
    fundingEngine.start();
  }
  if (env.batchExecutorEnabled) {
    batchExecutor.start();
  }

  return { batchExecutor, fundingEngine, router };
}
