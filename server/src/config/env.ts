import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SMOKE_MARKET_SYMBOLS, SUPPORTED_PERP_ASSETS } from "@/config/assets";

export interface ServerEnv {
  authRequired: boolean;
  authSessionSecret: string;
  batchExecutorEnabled: boolean;
  batchExecutorIntervalMs: number;
  batchExecutorPrefix: string;
  boundlessPrivateKeyConfigured: boolean;
  boundlessProgramUrl: string;
  boundlessRpcConfigured: boolean;
  assetCustodyRequired: boolean;
  collateralAsset: string;
  collateralAssetCode: string;
  collateralAssetIssuer: string;
  collateralTokenContract: string;
  collateralTokenDigest: string;
  conditionalOrdersOnchainRequired: boolean;
  fundingEngineEnabled: boolean;
  fundingImpactMargin: bigint;
  fundingIntervalMs: number;
  fundingMaxDelta?: bigint;
  fundingMinimumSamples: number;
  fundingPremiumMode: "fixed" | "impact-twap";
  fundingPremiumRate: bigint;
  fundingPremiumRateCap: bigint;
  fundingSampleIntervalMs: number;
  intentRegistryOnchainRequired: boolean;
  liquidationAutomationEnabled: boolean;
  liquidationAutomationIntervalMs: number;
  matcherServiceUrl: string;
  matcherServiceToken: string;
  matcherApiToken: string;
  matcherProvider: "risc0";
  matcherPort: number;
  mongodbCollection: string;
  mongodbDatabase: string;
  mongodbUri: string;
  marketId: string;
  port: number;
  nodeEnv: string;
  oracleAssetAddress: string;
  oracleAssetSymbol: string;
  oracleAssetType: string;
  oracleBeamFeeToken: string;
  oracleContractId: string;
  oracleKind: string;
  oracleOnchainRequired: boolean;
  oraclePriceSource: "hermes" | "onchain-market";
  oracleMaxConfidenceBps: bigint;
  oracleCommitteeMaxAgeSeconds: number;
  oracleCommitteeMaxDeviationBps: number;
  oracleCommitteeThreshold: number;
  oraclePriceMaxAgeSeconds: number;
  oraclePriceDecimals: number;
  oraclePublisherAddresses: string[];
  oraclePublisherSources: string[];
  oraclePublishMode: string;
  oracleTwapRecords: number;
  protocolAdminAddresses: string[];
  protocolAdminRequired: boolean;
  privateMatchingRequired: boolean;
  pythBtcUsdFeedId: string;
  pythFeedIds: Record<string, string>;
  pythHermesUrl: string;
  risc0DevMode: boolean;
  smokeMarketSymbols: string[];
  serverWitnessRoutesEnabled: boolean;
  settlementsOnchainRequired: boolean;
  stellarDeployerAddress: string;
  stellarDeploymentFile: string;
  stellarOnchainRelay: boolean;
  stellarRelayerMode: string;
  stellarNetwork: string;
  stellarNetworkPassphrase: string;
  stellarRpcUrl: string;
  stellarSource: string;
}

export function loadEnv(): ServerEnv {
  if (process.env.NODE_ENV !== "test") loadEnvFile();

  const nodeEnv = process.env.NODE_ENV ?? "development";
  const persistentByDefault = nodeEnv !== "test";
  const mongodbUri = value("MONGODB_URI", "");
  if (persistentByDefault && !mongodbUri) {
    throw new Error("MONGODB_URI is required for PNLX runtime");
  }
  const stellarRelayerMode = value("STELLAR_RELAYER_MODE", "local");
  const oracleOnchainRequired = booleanValue("ORACLE_ONCHAIN_REQUIRED", nodeEnv === "production");
  const authRequired = booleanValue("AUTH_REQUIRED", persistentByDefault);
  const authSessionSecret = value(
    "AUTH_SESSION_SECRET",
    nodeEnv === "test" ? "pnlx-test-auth-session-secret-at-least-32-bytes" : "",
  );
  if (authRequired && authSessionSecret.length < 32) {
    throw new Error("AUTH_SESSION_SECRET must contain at least 32 characters when auth is required");
  }
  const pythFeedIds = Object.fromEntries(
    Object.entries(SUPPORTED_PERP_ASSETS).map(([symbol, asset]) => [
      symbol,
      value(`PYTH_${symbol}_USD_FEED_ID`, asset.pythFeedId),
    ]),
  );

  return {
    authRequired,
    authSessionSecret,
    batchExecutorEnabled: booleanValue("BATCH_EXECUTOR_ENABLED", persistentByDefault),
    batchExecutorIntervalMs: Number(value("BATCH_EXECUTOR_INTERVAL_MS", "5000")),
    batchExecutorPrefix: value("BATCH_EXECUTOR_PREFIX", "auto"),
    boundlessPrivateKeyConfigured: Boolean(value("BOUNDLESS_PRIVATE_KEY", "")),
    boundlessProgramUrl: value("BOUNDLESS_PROGRAM_URL", ""),
    boundlessRpcConfigured: Boolean(value("BOUNDLESS_RPC_URL", "")),
    assetCustodyRequired: booleanValue("ASSET_CUSTODY_REQUIRED", persistentByDefault),
    collateralAsset: value("COLLATERAL_ASSET", ""),
    collateralAssetCode: value("COLLATERAL_ASSET_CODE", ""),
    collateralAssetIssuer: value("COLLATERAL_ASSET_ISSUER", ""),
    collateralTokenContract: value("COLLATERAL_TOKEN_CONTRACT", ""),
    collateralTokenDigest: value("COLLATERAL_TOKEN_DIGEST", ""),
    conditionalOrdersOnchainRequired: booleanValue(
      "CONDITIONAL_ORDERS_ONCHAIN_REQUIRED",
      nodeEnv === "production",
    ),
    fundingEngineEnabled: booleanValue("FUNDING_ENGINE_ENABLED", persistentByDefault),
    fundingImpactMargin: BigInt(value("FUNDING_IMPACT_MARGIN", "5000000000")),
    fundingIntervalMs: Number(value("FUNDING_INTERVAL_MS", String(60 * 60 * 1000))),
    fundingMaxDelta: optionalBigInt("FUNDING_MAX_DELTA"),
    fundingMinimumSamples: Number(value("FUNDING_MINIMUM_SAMPLES", "10")),
    fundingPremiumMode: fundingPremiumMode(value("FUNDING_PREMIUM_MODE", "fixed")),
    fundingPremiumRate: BigInt(value("FUNDING_PREMIUM_RATE", "0")),
    fundingPremiumRateCap: BigInt(value("FUNDING_PREMIUM_RATE_CAP", "5000")),
    fundingSampleIntervalMs: Number(value("FUNDING_SAMPLE_INTERVAL_MS", "60000")),
    intentRegistryOnchainRequired: booleanValue("INTENT_REGISTRY_ONCHAIN_REQUIRED", nodeEnv === "production"),
    liquidationAutomationEnabled: booleanValue("LIQUIDATION_AUTOMATION_ENABLED", persistentByDefault),
    liquidationAutomationIntervalMs: Number(value("LIQUIDATION_AUTOMATION_INTERVAL_MS", "5000")),
    matcherServiceUrl: value("MATCHER_SERVICE_URL", value("EXTERNAL_MATCHER_URL", "")),
    matcherServiceToken: value("MATCHER_SERVICE_TOKEN", value("EXTERNAL_MATCHER_TOKEN", "")),
    matcherApiToken: value("MATCHER_API_TOKEN", ""),
    matcherProvider: matcherProvider(value("MATCHER_PROVIDER", "risc0")),
    matcherPort: Number(value("MATCHER_PORT", "4102")),
    mongodbCollection: value("MONGODB_PROTOCOL_COLLECTION", "protocol_state"),
    mongodbDatabase: value("MONGODB_DATABASE", "pnlx"),
    mongodbUri,
    marketId: value("PNLX_MARKET_ID", "xlm-usd-perp"),
    port: Number(process.env.PORT ?? 4000),
    nodeEnv,
    oracleAssetAddress: value("ORACLE_ASSET_ADDRESS", ""),
    oracleAssetSymbol: value("ORACLE_ASSET_SYMBOL", "BTC"),
    oracleAssetType: value("ORACLE_ASSET_TYPE", "other"),
    oracleBeamFeeToken: value("ORACLE_BEAM_FEE_TOKEN", ""),
    oracleContractId: value("ORACLE_CONTRACT_ID", ""),
    oracleKind: value("ORACLE_KIND", "sep40"),
    oracleOnchainRequired,
    oraclePriceSource: oraclePriceSource(
      value("ORACLE_PRICE_SOURCE", oracleOnchainRequired ? "onchain-market" : "hermes"),
    ),
    oracleMaxConfidenceBps: BigInt(value("ORACLE_MAX_CONFIDENCE_BPS", "100")),
    oracleCommitteeMaxAgeSeconds: Number(value("ORACLE_COMMITTEE_MAX_AGE_SECONDS", value("ORACLE_PRICE_MAX_AGE_SECONDS", "120"))),
    oracleCommitteeMaxDeviationBps: Number(value("ORACLE_COMMITTEE_MAX_DEVIATION_BPS", "100")),
    oracleCommitteeThreshold: Number(value("ORACLE_COMMITTEE_THRESHOLD", "2")),
    oraclePriceMaxAgeSeconds: Number(value("ORACLE_PRICE_MAX_AGE_SECONDS", "120")),
    oraclePriceDecimals: Number(value("ORACLE_PRICE_DECIMALS", "8")),
    oraclePublisherAddresses: listValue("ORACLE_PUBLISHER_ADDRESSES", []),
    oraclePublisherSources: listValue("ORACLE_PUBLISHER_SOURCES", [], { uppercase: false }),
    oraclePublishMode: value("ORACLE_PUBLISH_MODE", "committee"),
    oracleTwapRecords: Number(value("ORACLE_TWAP_RECORDS", "1")),
    protocolAdminAddresses: listValue("PROTOCOL_ADMIN_ADDRESSES", []),
    protocolAdminRequired: booleanValue("PROTOCOL_ADMIN_REQUIRED", nodeEnv === "production"),
    privateMatchingRequired: booleanValue("PRIVATE_MATCHING_REQUIRED", nodeEnv === "production"),
    pythBtcUsdFeedId: pythFeedIds.BTC,
    pythFeedIds,
    pythHermesUrl: value("PYTH_HERMES_URL", "https://hermes.pyth.network"),
    risc0DevMode: booleanValue("RISC0_DEV_MODE", false),
    smokeMarketSymbols: listValue("PNLX_SMOKE_MARKETS", DEFAULT_SMOKE_MARKET_SYMBOLS),
    serverWitnessRoutesEnabled: booleanValue("SERVER_WITNESS_ROUTES_ENABLED", nodeEnv === "test"),
    settlementsOnchainRequired: booleanValue("SETTLEMENTS_ONCHAIN_REQUIRED", nodeEnv === "production"),
    stellarDeployerAddress: value("STELLAR_DEPLOYER_ADDRESS", ""),
    stellarDeploymentFile: value("STELLAR_DEPLOYMENT_FILE", "deployments/testnet.json"),
    stellarOnchainRelay: booleanValue("STELLAR_ONCHAIN_RELAY", stellarRelayerMode === "stellar-cli"),
    stellarRelayerMode,
    stellarNetwork: value("STELLAR_NETWORK", "testnet"),
    stellarNetworkPassphrase: value(
      "STELLAR_NETWORK_PASSPHRASE",
      "Test SDF Network ; September 2015",
    ),
    stellarRpcUrl: value("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org/"),
    stellarSource: value("STELLAR_SOURCE", "pnlx-testnet"),
  };
}

function loadEnvFile(path = join(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;

    const key = trimmed.slice(0, equals).trim();
    const raw = trimmed.slice(equals + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = unquote(raw);
    }
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function value(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function listValue(key: string, fallback: string[], options: { uppercase?: boolean } = {}): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((entry) => {
      const trimmed = entry.trim();
      return options.uppercase === false ? trimmed : trimmed.toUpperCase();
    })
    .filter(Boolean);
}

function booleanValue(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

function optionalBigInt(key: string): bigint | undefined {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? undefined : BigInt(raw);
}

function matcherProvider(value: string): ServerEnv["matcherProvider"] {
  if (value === "risc0") return value;
  throw new Error("MATCHER_PROVIDER must be risc0");
}

function oraclePriceSource(value: string): "hermes" | "onchain-market" {
  if (value === "hermes" || value === "onchain-market") return value;
  throw new Error("ORACLE_PRICE_SOURCE must be hermes or onchain-market");
}

function fundingPremiumMode(value: string): ServerEnv["fundingPremiumMode"] {
  if (value === "fixed" || value === "impact-twap") return value;
  throw new Error("FUNDING_PREMIUM_MODE must be fixed or impact-twap");
}
