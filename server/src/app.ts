import { registerAccountKeysRoute } from "@/features/account-keys/account-keys.route";
import { registerAccountEventsRoute } from "@/features/account-events/account-events.route";
import { registerAuthRoute } from "@/features/auth/auth.route";
import { registerSurveyRoute } from "@/features/survey/survey.route";
import { registerBatchesRoute } from "@/features/batches/batches.route";
import { registerConditionalOrdersRoute } from "@/features/conditional-orders/conditional-orders.route";
import { registerDisclosuresRoute } from "@/features/disclosures/disclosures.route";
import { registerFundingRoute } from "@/features/funding/funding.route";
import { registerHealthRoute } from "@/features/health/health.route";
import { registerIntentsRoute } from "@/features/intents/intents.route";
import { IntentsService } from "@/features/intents/intents.service";
import { registerLiquidationAutomationRoute } from "@/features/liquidation-automation/liquidation-automation.route";
import { registerLiquidationsRoute } from "@/features/liquidations/liquidations.route";
import { registerLiquidityVaultRoute } from "@/features/liquidity-vault/liquidity-vault.route";
import { LiquidityVaultHistory } from "@/features/liquidity-vault/liquidity-vault.history";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import { registerMarketsRoute } from "@/features/markets/markets.route";
import { MarketsService } from "@/features/markets/markets.service";
import { registerNotesRoute } from "@/features/notes/notes.route";
import { registerNoteBackupRoutes } from "@/features/notes/note-backups";
import { LegacyExitRecoveryService } from "@/features/notes/legacy-exit-recovery";
import { registerOrdersRoute } from "@/features/orders/orders.route";
import { registerPositionClosesRoute } from "@/features/position-closes/position-closes.route";
import { registerPortfolioRoute } from "@/features/portfolio/portfolio.route";
import { registerPointsRoute } from "@/features/points/points.route";
import { registerRewardsRoute } from "@/features/rewards/rewards.route";
import { registerProofsRoute } from "@/features/proofs/proofs.route";
import { registerRelaysRoute } from "@/features/relays/relays.route";
import { loadEnv } from "@/config/env";
import { Router } from "@/shared/http/router";
import { AuthService } from "@/features/auth/auth.service";
import { LiquidationAutomationService } from "@/features/liquidation-automation/liquidation-automation.service";
import { LiquidationsService } from "@/features/liquidations/liquidations.service";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";
import { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";
import { ProtectionKeeperService } from "@/workers/protection-keeper/protection-keeper.service";
import { createExecutor, createExecutorAsync } from "@/workers/executor/executor.worker";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { createBatchExecutor } from "@/workers/batch-executor/batch-executor.worker";
import type { BatchExecutorService } from "@/workers/batch-executor/batch-executor.service";
import { createMatcher } from "@/workers/matcher/matcher.worker";
import { RemoteMatcherClient } from "@/workers/matcher/remote/matcher.service";
import { MakerLiquidityService } from "@/workers/maker-liquidity/maker-liquidity.service";
import { createFundingEngine } from "@/workers/funding-engine/funding-engine.worker";
import type { FundingEngineService } from "@/workers/funding-engine/funding-engine.service";
import { OracleService } from "@/workers/oracle/oracle.service";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createOnchainRelay } from "@/workers/onchain/onchain.worker";
import { createProver } from "@/workers/prover/prover.worker";
import { createRelayer } from "@/workers/relayer/relayer.worker";

export interface AppRuntime {
  batchExecutor: BatchExecutorService;
  executor: ExecutorService;
  fundingEngine: FundingEngineService;
  liquidationAutomation: LiquidationAutomationService;
  protectionKeeper: ProtectionKeeperService;
  liquidityHistory?: LiquidityVaultHistory;
  router: Router;
  recoverPendingIntents: () => Promise<{ recovered: number; pending: number }>;
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
  const runtime = buildAppRuntime(env, executor, false);
  await runtime.recoverPendingIntents();
  startRuntimeWorkers(runtime, env);
  return runtime;
}

function buildAppRuntime(env: ReturnType<typeof loadEnv>, executor: ExecutorService, startWorkers = true): AppRuntime {
  const auth = new AuthService(env.stellarNetworkPassphrase, env.authSessionSecret);
  const router = new Router({
    authenticate: (request) => auth.authenticateRequest(request),
    protectMutations: env.authRequired,
  });
  const prover = createProver();
  const deployment = env.stellarOnchainRelay
    ? loadDeploymentRegistry(env.stellarDeploymentFile)
    : undefined;
  const oracle = new OracleService({
    apiKey: env.pythHermesApiKey,
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
      commandTimeoutMs: env.stellarCommandTimeoutMs,
      mode: env.stellarRelayerMode === "stellar-cli" ? "stellar-cli" : "local",
      network: env.stellarNetwork,
      networkPassphrase: env.stellarNetworkPassphrase,
      rpcUrl: env.stellarRpcUrl,
      source: env.stellarSource,
    },
  });
  const onchain = env.stellarOnchainRelay
    ? createOnchainRelay(relayer, {
        deployment,
        enabled: true,
        resolveProofArtifact: (proof) => prover.artifactFor(proof) ?? executor.artifactFor(proof),
      })
    : undefined;
  if (env.assetCustodyRequired && onchain) {
    const notes = onchain.secureNoteSnapshot([...executor.store.marginCommitments]);
    executor.store.replaceMarginCommitments(notes.commitments);
  }
  const fundingEngine = createFundingEngine(
    executor,
    {
      impactMargin: env.fundingImpactMargin,
      intervalMs: env.fundingIntervalMs,
      maxFundingDelta: env.fundingMaxDelta,
      minimumSamples: env.fundingMinimumSamples,
      premiumMode: env.fundingPremiumMode,
      premiumRate: env.fundingPremiumRate,
      premiumRateCap: env.fundingPremiumRateCap,
      sampleIntervalMs: env.fundingSampleIntervalMs,
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
  const vaultContractId = deployment?.contracts["liquidity-vault"];
  const makerLiquidity = new MakerLiquidityService(
    executor,
    prover,
    onchain,
    env,
    vaultContractId && env.collateralTokenContract
      ? {
          asset: env.collateralTokenContract,
          readDeployedPrincipal: async () => {
            const result = await relayer.readAsync({
              kind: "contract-invoke",
              payload: { contractId: vaultContractId, functionName: "deployed_principal", send: "no" },
            });
            const raw = result.output.trim();
            const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
            if (!/^[0-9]+$/.test(String(value))) throw new Error("invalid vault deployed principal");
            return BigInt(value);
          },
          readSeriesPrincipal: async (series) => {
            const result = await relayer.readAsync({
              kind: "contract-invoke",
              payload: { args: ["--series", String(series)], contractId: vaultContractId,
                functionName: "series_principal", send: "no" },
            });
            const raw = result.output.trim();
            const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
            if (!/^[0-9]+$/.test(String(value))) throw new Error("invalid vault series principal");
            return BigInt(value);
          },
          vault: vaultContractId,
        }
      : undefined,
  );
  const markets = new MarketsService(executor, oracle, env, onchain, undefined, fundingEngine);
  const batchExecutor = createBatchExecutor(
    executor,
    matcher,
    {
      batchIdPrefix: env.batchExecutorPrefix,
      intervalMs: env.batchExecutorIntervalMs,
      proofPipelineConcurrency: env.batchExecutorProofConcurrency,
      refreshMarketOracle: (marketId, signal) =>
        markets.refreshFromOracle(
          { marketId },
          env.protocolAdminAddresses[0] ?? deployment?.sourceAddress,
          signal,
        ).then(() => undefined),
      sampleFundingPremium: (marketId, sampledAt) => {
        if (env.fundingPremiumMode === "impact-twap") {
          fundingEngine.sampleSafely({ marketId, sampledAt });
        }
      },
      settlementsOnchainRequired: env.settlementsOnchainRequired || Boolean(onchain?.enabled),
    },
    onchain,
    makerLiquidity,
  );
  const liquidations = new LiquidationsService(executor, prover, onchain, env);
  const liquidationAutomation = new LiquidationAutomationService(executor, liquidations, {
    intervalMs: env.liquidationAutomationIntervalMs,
  });
  const protectionKeeper = new ProtectionKeeperService(executor,
    new PositionClosesService(executor,prover,onchain,env),
    new ConditionalOrdersService(executor,prover,env,onchain),onchain,env.liquidationAutomationIntervalMs);

  registerAuthRoute(router, auth);
  registerSurveyRoute(router, { uri: env.mongodbUri, database: env.mongodbDatabase });
  registerHealthRoute(router, env, onchain, executor.store,()=>({
    protection:{enabled:env.liquidationAutomationEnabled,...protectionKeeper.status,
      fresh:env.liquidationAutomationEnabled && protectionKeeper.status.lastCompletedAt>0 &&
        Date.now()-protectionKeeper.status.lastCompletedAt<Math.max(30_000,env.liquidationAutomationIntervalMs*3)},
    pendingPairedCloses:[...executor.store.pendingPairedCloses.values()].filter((run)=>!run.retired).length,
    archivedPairedCloses:[...executor.store.pendingPairedCloses.values()].filter((run)=>run.retired).length,
    pendingIntentSubmissions:executor.store.pendingIntentSubmissions.size,
    schedulerOwnership:"single-active-process-required",
  }), fundingEngine);
  const legacyExitRecovery = new LegacyExitRecoveryService(env, relayer, deployment?.contracts["legacy-pair-exit"]);
  registerAccountKeysRoute(router, executor, legacyExitRecovery);
  registerAccountEventsRoute(router, executor);
  registerPortfolioRoute(router, executor);
  registerPointsRoute(router, executor.store, env.makerWalletAddress);
  registerRewardsRoute(router, relayer, executor.store, env, deployment);
  registerNotesRoute(router, executor, prover, env, onchain, relayer);
  registerNoteBackupRoutes(router, executor, env, relayer, deployment?.contracts["shielded-pool"], legacyExitRecovery);
  registerMarketsRoute(router, executor, oracle, env, onchain, markets);
  registerFundingRoute(router, executor, env, fundingEngine);
  registerIntentsRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerOrdersRoute(router, executor, prover, env, onchain, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerBatchesRoute(router, executor, env, onchain, batchExecutor);
  registerProofsRoute(router, prover, {
    witnessRoutesEnabled: env.serverWitnessRoutesEnabled,
  });
  registerRelaysRoute(router, relayer, env, executor);
  const vaultId = deployment?.contracts["liquidity-vault"];
  const vaultService = vaultId ? new LiquidityVaultService(relayer, deployment) : undefined;
  const liquidityHistory = vaultId && vaultService && env.mongodbUri ? new LiquidityVaultHistory(
    vaultService,
    { uri: env.mongodbUri, database: env.mongodbDatabase, network: env.stellarNetwork,
      rpcUrl: env.stellarRpcUrl, vaultId },
  ) : undefined;
  if (vaultService) registerLiquidityVaultRoute(router, vaultService, liquidityHistory);
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

  const intents = new IntentsService(executor, prover, onchain, env);
  const runtime = { batchExecutor, executor, fundingEngine, liquidationAutomation, protectionKeeper, liquidityHistory, router,
    recoverPendingIntents: () => intents.recoverPendingIntents() };
  if (startWorkers) startRuntimeWorkers(runtime, env);
  return runtime;
}

function startRuntimeWorkers(runtime: AppRuntime, env: ReturnType<typeof loadEnv>): void {
  if (env.nodeEnv !== "test" && env.fundingPremiumMode === "impact-twap") runtime.fundingEngine.startSampling();
  if (env.fundingEngineEnabled) runtime.fundingEngine.start();
  if (env.batchExecutorEnabled) runtime.batchExecutor.start();
  if (env.liquidationAutomationEnabled) {
    runtime.liquidationAutomation.start();
    runtime.protectionKeeper.start();
  }
}

function createExecutorForEnv(env: ReturnType<typeof loadEnv>): ExecutorService {
  if (env.nodeEnv !== "test") {
    throw new Error("PNLX runtime uses MongoDB and must start with createAppAsync()");
  }
  return createExecutor({
    privateMatchingRequired: env.privateMatchingRequired,
  });
}

async function createExecutorForEnvAsync(env: ReturnType<typeof loadEnv>): Promise<ExecutorService> {
  if (env.nodeEnv === "test" && !env.mongodbUri) {
    return createExecutor({
      privateMatchingRequired: env.privateMatchingRequired,
    });
  }
  if (!env.mongodbUri) throw new Error("MONGODB_URI is required for PNLX runtime");
  return createExecutorAsync({
    mongo: {
      collection: env.mongodbCollection,
      database: env.mongodbDatabase,
      documentId: env.stellarNetwork,
      ensureIndexes: true,
      uri: env.mongodbUri,
    },
    privateMatchingRequired: env.privateMatchingRequired,
  });
}
