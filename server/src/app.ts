import { registerAccountKeysRoute } from "@/features/account-keys/account-keys.route";
import { registerAccountEventsRoute } from "@/features/account-events/account-events.route";
import { registerAuthRoute } from "@/features/auth/auth.route";
import { registerBatchesRoute } from "@/features/batches/batches.route";
import { registerConditionalOrdersRoute } from "@/features/conditional-orders/conditional-orders.route";
import { registerDisclosuresRoute } from "@/features/disclosures/disclosures.route";
import { registerFundingRoute } from "@/features/funding/funding.route";
import { registerHealthRoute } from "@/features/health/health.route";
import { registerIntentsRoute } from "@/features/intents/intents.route";
import { registerLiquidationAutomationRoute } from "@/features/liquidation-automation/liquidation-automation.route";
import { registerLiquidationsRoute } from "@/features/liquidations/liquidations.route";
import { registerMarketsRoute } from "@/features/markets/markets.route";
import { registerNotesRoute } from "@/features/notes/notes.route";
import { registerOrdersRoute } from "@/features/orders/orders.route";
import { registerPositionClosesRoute } from "@/features/position-closes/position-closes.route";
import { registerPortfolioRoute } from "@/features/portfolio/portfolio.route";
import { registerProofsRoute } from "@/features/proofs/proofs.route";
import { registerRelaysRoute } from "@/features/relays/relays.route";
import { loadEnv } from "@/config/env";
import { Router } from "@/shared/http/router";
import { AuthService } from "@/features/auth/auth.service";
import { LiquidationAutomationService } from "@/features/liquidation-automation/liquidation-automation.service";
import { LiquidationsService } from "@/features/liquidations/liquidations.service";
import { createExecutor, createExecutorAsync } from "@/workers/executor/executor.worker";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { createBatchExecutor } from "@/workers/batch-executor/batch-executor.worker";
import type { BatchExecutorService } from "@/workers/batch-executor/batch-executor.service";
import { createMatcher } from "@/workers/matcher/matcher.worker";
import { RemoteMatcherClient } from "@/workers/matcher/remote/matcher.service";
import { createFundingEngine } from "@/workers/funding-engine/funding-engine.worker";
import type { FundingEngineService } from "@/workers/funding-engine/funding-engine.service";
import { OracleService } from "@/workers/oracle/oracle.service";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createOnchainRelay } from "@/workers/onchain/onchain.worker";
import { createProver } from "@/workers/prover/prover.worker";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { startBackgroundJobQueues, type BackgroundJobQueues } from "@/workers/jobs/background-queues";

export interface AppRuntime {
  batchExecutor: BatchExecutorService;
  backgroundJobs?: BackgroundJobQueues;
  executor: ExecutorService;
  fundingEngine: FundingEngineService;
  liquidationAutomation: LiquidationAutomationService;
  router: Router;
}

export function createApp(): Router {
  return createAppRuntime().router;
}

export async function createAppAsync(): Promise<Router> {
  return (await createAppRuntimeAsync()).router;
}

export function createAppRuntime(): AppRuntime {
  const env = loadEnv();
  const executor = createExecutorForEnv(env);
  return buildAppRuntime(env, executor);
}

export async function createAppRuntimeAsync(): Promise<AppRuntime> {
  const env = loadEnv();
  const executor = await createExecutorForEnvAsync(env);
  return buildAppRuntime(env, executor);
}

function buildAppRuntime(env: ReturnType<typeof loadEnv>, executor: ExecutorService): AppRuntime {
  const auth = new AuthService(env.stellarNetworkPassphrase, env.authStorePath || undefined);
  const router = new Router({
    authenticate: (request) => auth.authenticateRequest(request),
    protectMutations: env.authRequired,
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
  if (env.privateMatchingRequired && !env.matcherServiceUrl) {
    throw new Error("MATCHER_SERVICE_URL is required for private matcher service");
  }
  const matcher = env.matcherServiceUrl
    ? new RemoteMatcherClient({
        token: env.matcherServiceToken || undefined,
        url: env.matcherServiceUrl,
      })
    : createMatcher(executor);
  const batchExecutor = createBatchExecutor(
    executor,
    matcher,
    {
      batchIdPrefix: env.batchExecutorPrefix,
      intervalMs: env.batchExecutorIntervalMs,
      settlementsOnchainRequired: env.settlementsOnchainRequired,
    },
    onchain,
  );
  const liquidations = new LiquidationsService(executor, prover, onchain, env);
  const liquidationAutomation = new LiquidationAutomationService(executor, liquidations, {
    intervalMs: env.liquidationAutomationIntervalMs,
  });

  registerAuthRoute(router, auth);
  registerHealthRoute(router, env, onchain);
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
  registerRelaysRoute(router, relayer, env, executor);
  registerLiquidationsRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerLiquidationAutomationRoute(router, liquidationAutomation);
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
  let backgroundJobs: BackgroundJobQueues | undefined;
  if (env.jobQueueDriver === "bullmq") {
    backgroundJobs = startBackgroundJobQueues({
      batchExecutor,
      batchExecutorEnabled: env.batchExecutorEnabled,
      batchExecutorIntervalMs: env.batchExecutorIntervalMs,
      batchExecutorPrefix: env.batchExecutorPrefix,
      liquidationAutomation,
      liquidationAutomationEnabled: env.liquidationAutomationEnabled,
      liquidationAutomationIntervalMs: env.liquidationAutomationIntervalMs,
      redisUrl: env.redisUrl,
    });
  } else if (env.batchExecutorEnabled) {
    batchExecutor.start();
  }
  if (env.jobQueueDriver !== "bullmq" && env.liquidationAutomationEnabled) {
    liquidationAutomation.start();
  }

  return { backgroundJobs, batchExecutor, executor, fundingEngine, liquidationAutomation, router };
}

function createExecutorForEnv(env: ReturnType<typeof loadEnv>): ExecutorService {
  if (env.protocolStorageDriver === "mongodb") {
    throw new Error("MongoDB protocol storage requires async app startup");
  }
  return createExecutor({
    privateMatchingRequired: env.privateMatchingRequired,
    storePath: env.protocolStorageDriver === "file" ? env.protocolStorePath || undefined : undefined,
  });
}

async function createExecutorForEnvAsync(env: ReturnType<typeof loadEnv>): Promise<ExecutorService> {
  if (env.protocolStorageDriver === "mongodb") {
    if (!env.mongodbUri) throw new Error("MONGODB_URI is required when PROTOCOL_STORAGE_DRIVER=mongodb");
    return createExecutorAsync({
      mongo: {
        collection: env.mongodbCollection,
        database: env.mongodbDatabase,
        documentId: env.stellarNetwork,
        uri: env.mongodbUri,
      },
      privateMatchingRequired: env.privateMatchingRequired,
    });
  }
  return createExecutorForEnv(env);
}
