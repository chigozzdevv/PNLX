import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SMOKE_MARKET_SYMBOLS, SUPPORTED_PERP_ASSETS } from "@/config/assets";

export interface ServerEnv {
  authStorePath: string;
  authRequired: boolean;
  batchExecutorEnabled: boolean;
  batchExecutorIntervalMs: number;
  batchExecutorPrefix: string;
  assetCustodyRequired: boolean;
  collateralAsset: string;
  collateralAssetCode: string;
  collateralAssetIssuer: string;
  collateralTokenContract: string;
  collateralTokenDigest: string;
  conditionalOrdersOnchainRequired: boolean;
  fundingEngineEnabled: boolean;
  fundingIntervalMs: number;
  fundingMaxDelta?: bigint;
  fundingPremiumRate: bigint;
  intentRegistryOnchainRequired: boolean;
  liquidationAutomationEnabled: boolean;
  liquidationAutomationIntervalMs: number;
  matchingBackend: "threshold-recovery" | "external-blind";
  matcherServiceUrl: string;
  matcherServiceToken: string;
  matcherApiToken: string;
  matcherProvider: "risc0";
  matcherPort: number;
  marketId: string;
  thresholdShareNodeIds: string[];
  thresholdShareStoreDir: string;
  thresholdShareThreshold: number;
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
  protocolLiquidityEnabled: boolean;
  protocolLiquidityMaxNotional: bigint;
  protocolLiquidityOwner: string;
  protocolLiquidityPublicKey: string;
  protocolLiquidityQuoteSpreadBps: bigint;
  protocolStorePath: string;
  privateMatchingRequired: boolean;
  pythBtcUsdFeedId: string;
  pythFeedIds: Record<string, string>;
  pythHermesUrl: string;
  smokeMarketSymbols: string[];
  relayStorePath: string;
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
  const runtimeDir = value("PNLX_RUNTIME_DIR", ".pnlx");
  const persistentByDefault = nodeEnv !== "test";
  const stellarRelayerMode = value("STELLAR_RELAYER_MODE", "local");
  const oracleOnchainRequired = booleanValue("ORACLE_ONCHAIN_REQUIRED", nodeEnv === "production");
  const pythFeedIds = Object.fromEntries(
    Object.entries(SUPPORTED_PERP_ASSETS).map(([symbol, asset]) => [
      symbol,
      value(`PYTH_${symbol}_USD_FEED_ID`, asset.pythFeedId),
    ]),
  );

  return {
    authStorePath: value("AUTH_STORE_PATH", persistentByDefault ? join(runtimeDir, "auth-state.json") : ""),
    authRequired: booleanValue("AUTH_REQUIRED", persistentByDefault),
    batchExecutorEnabled: booleanValue("BATCH_EXECUTOR_ENABLED", false),
    batchExecutorIntervalMs: Number(value("BATCH_EXECUTOR_INTERVAL_MS", "5000")),
    batchExecutorPrefix: value("BATCH_EXECUTOR_PREFIX", "auto"),
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
    fundingIntervalMs: Number(value("FUNDING_INTERVAL_MS", String(60 * 60 * 1000))),
    fundingMaxDelta: optionalBigInt("FUNDING_MAX_DELTA"),
    fundingPremiumRate: BigInt(value("FUNDING_PREMIUM_RATE", "0")),
    intentRegistryOnchainRequired: booleanValue("INTENT_REGISTRY_ONCHAIN_REQUIRED", nodeEnv === "production"),
    liquidationAutomationEnabled: booleanValue("LIQUIDATION_AUTOMATION_ENABLED", persistentByDefault),
    liquidationAutomationIntervalMs: Number(value("LIQUIDATION_AUTOMATION_INTERVAL_MS", "5000")),
    matchingBackend: matchingBackend(value("MATCHING_BACKEND", nodeEnv === "production" ? "external-blind" : "threshold-recovery")),
    matcherServiceUrl: value("MATCHER_SERVICE_URL", value("EXTERNAL_MATCHER_URL", "")),
    matcherServiceToken: value("MATCHER_SERVICE_TOKEN", value("EXTERNAL_MATCHER_TOKEN", "")),
    matcherApiToken: value("MATCHER_API_TOKEN", ""),
    matcherProvider: matcherProvider(value("MATCHER_PROVIDER", "risc0")),
    matcherPort: Number(value("MATCHER_PORT", "4102")),
    marketId: value("PNLX_MARKET_ID", "xlm-usd-perp"),
    thresholdShareNodeIds: listValue("THRESHOLD_SHARE_NODE_IDS", ["node-a", "node-b", "node-c"], { uppercase: false }),
    thresholdShareStoreDir: value("THRESHOLD_SHARE_STORE_DIR", persistentByDefault ? join(runtimeDir, "threshold-shares") : ""),
    thresholdShareThreshold: Number(value("THRESHOLD_SHARE_THRESHOLD", "2")),
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
    protocolLiquidityEnabled: booleanValue("PROTOCOL_LIQUIDITY_ENABLED", false),
    protocolLiquidityMaxNotional: BigInt(value("PROTOCOL_LIQUIDITY_MAX_NOTIONAL", "50000")),
    protocolLiquidityOwner: value("PROTOCOL_LIQUIDITY_OWNER", "pnlx-protocol-liquidity"),
    protocolLiquidityPublicKey: value("PROTOCOL_LIQUIDITY_PUBLIC_KEY", ""),
    protocolLiquidityQuoteSpreadBps: BigInt(value("PROTOCOL_LIQUIDITY_QUOTE_SPREAD_BPS", "10")),
    protocolStorePath: value(
      "PROTOCOL_STORE_PATH",
      persistentByDefault ? join(runtimeDir, "protocol-store.json") : "",
    ),
    privateMatchingRequired: booleanValue("PRIVATE_MATCHING_REQUIRED", nodeEnv === "production"),
    pythBtcUsdFeedId: pythFeedIds.BTC,
    pythFeedIds,
    pythHermesUrl: value("PYTH_HERMES_URL", "https://hermes.pyth.network"),
    smokeMarketSymbols: listValue("PNLX_SMOKE_MARKETS", DEFAULT_SMOKE_MARKET_SYMBOLS),
    relayStorePath: value("RELAY_STORE_PATH", persistentByDefault ? join(runtimeDir, "relay-state.json") : ""),
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

function matchingBackend(value: string): ServerEnv["matchingBackend"] {
  if (value === "threshold-recovery" || value === "external-blind") return value;
  throw new Error("MATCHING_BACKEND must be threshold-recovery or external-blind");
}

function matcherProvider(value: string): ServerEnv["matcherProvider"] {
  if (value === "risc0") return value;
  throw new Error("MATCHER_PROVIDER must be risc0");
}

function oraclePriceSource(value: string): "hermes" | "onchain-market" {
  if (value === "hermes" || value === "onchain-market") return value;
  throw new Error("ORACLE_PRICE_SOURCE must be hermes or onchain-market");
}
