import { json } from "@/shared/http/json";
import { oracleReadinessIssues } from "@/shared/protocol/oracle";
import type { ServerEnv } from "@/config/env";
import type { Hex } from "@pnlx/protocol-types";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";

export class HealthController {
  private collateralTokenDigestCache?: Hex | null;

  constructor(
    private readonly env: ServerEnv,
    private readonly onchain?: Pick<OnchainRelayService, "enabled" | "tokenDigest">,
  ) {}

  get(): Response {
    const custodyIssues = custodyReadinessIssues(this.env);
    const governanceIssues = governanceReadinessIssues(this.env);
    const intentRegistryIssues = intentRegistryReadinessIssues(this.env);
    const conditionalOrderIssues = conditionalOrderReadinessIssues(this.env);
    const settlementIssues = settlementReadinessIssues(this.env);
    const oracleIssues = oracleReadinessIssues(this.env);
    const matchingIssues = matchingReadinessIssues(this.env);
    return json({
      ok: true,
      service: "pnlx-server",
      auth: {
        required: this.env.authRequired,
      },
      privacy: {
        serverWitnessRoutesEnabled: this.env.serverWitnessRoutesEnabled,
      },
      governance: {
        protocolAdminCount: this.env.protocolAdminAddresses.length,
        protocolAdminRequired: this.env.protocolAdminRequired,
        readyForGovernedMutations: governanceIssues.length === 0,
        issues: governanceIssues,
      },
      intentRegistry: {
        onchainRequired: this.env.intentRegistryOnchainRequired,
        readyForOnchainRegistration: intentRegistryIssues.length === 0,
        issues: intentRegistryIssues,
      },
      custody: {
        required: this.env.assetCustodyRequired,
        plainNotesEnabled: !this.env.assetCustodyRequired,
        readyForRealAssets: custodyIssues.length === 0,
        collateralAsset: {
          asset: this.env.collateralAsset,
          code: this.env.collateralAssetCode,
          issuer: this.env.collateralAssetIssuer,
          tokenContract: this.env.collateralTokenContract,
          tokenDigest: this.collateralTokenDigest(),
        },
        collateralTokenConfigured: Boolean(this.env.collateralTokenContract),
        onchainRelayEnabled: this.env.stellarOnchainRelay,
        issues: custodyIssues,
      },
      conditionalOrders: {
        onchainRequired: this.env.conditionalOrdersOnchainRequired,
        readyForOnchainRegistration: conditionalOrderIssues.length === 0,
        issues: conditionalOrderIssues,
      },
      settlements: {
        onchainRequired: this.env.settlementsOnchainRequired,
        readyForOnchainFinality: settlementIssues.length === 0,
        issues: settlementIssues,
      },
      funding: {
        enabled: this.env.fundingEngineEnabled,
        intervalMs: this.env.fundingIntervalMs,
      },
      batchExecutor: {
        enabled: this.env.batchExecutorEnabled,
        intervalMs: this.env.batchExecutorIntervalMs,
        prefix: this.env.batchExecutorPrefix,
      },
      matching: {
        matcherService: {
          configured: Boolean(this.env.matcherServiceUrl),
          url: this.env.matcherServiceUrl ? redactUrl(this.env.matcherServiceUrl) : "",
        },
        proofEngine: {
          provider: this.env.matcherProvider,
          proofSystem: "risc0-groth16",
        },
        privateMatchingRequired: this.env.privateMatchingRequired,
        readyForPrivateMatching: matchingIssues.length === 0,
        issues: matchingIssues,
      },
      oracle: {
        contractConfigured: Boolean(this.env.oracleContractId),
        hermesUrlConfigured: Boolean(this.env.pythHermesUrl),
        issues: oracleIssues,
        kind: this.env.oracleKind,
        onchainRequired: this.env.oracleOnchainRequired,
        committee: {
          maxAgeSeconds: this.env.oracleCommitteeMaxAgeSeconds,
          maxDeviationBps: this.env.oracleCommitteeMaxDeviationBps,
          ready: oracleIssues.length === 0,
          threshold: this.env.oracleCommitteeThreshold,
        },
        publishMode: this.env.oraclePublishMode,
        publisherCount: this.env.oraclePublisherAddresses.length,
        source: this.env.oraclePriceSource,
      },
      persistence: {
        authStore: Boolean(this.env.authStorePath),
        jobQueueDriver: this.env.jobQueueDriver,
        mongodb: {
          collection: this.env.mongodbCollection,
          database: this.env.mongodbDatabase,
          configured: Boolean(this.env.mongodbUri),
        },
        protocolStorageDriver: this.env.protocolStorageDriver,
        protocolStore: this.env.protocolStorageDriver === "mongodb"
          ? Boolean(this.env.mongodbUri)
          : Boolean(this.env.protocolStorePath),
        relayStore: Boolean(this.env.relayStorePath),
        redisConfigured: Boolean(this.env.redisUrl),
      },
      stellar: {
        network: this.env.stellarNetwork,
        networkPassphrase: this.env.stellarNetworkPassphrase,
        onchainRelayEnabled: this.env.stellarOnchainRelay,
        relayerMode: this.env.stellarRelayerMode,
      },
    });
  }

  private collateralTokenDigest(): Hex | undefined {
    if (this.collateralTokenDigestCache !== undefined) {
      return this.collateralTokenDigestCache ?? undefined;
    }
    if (this.env.collateralTokenDigest) {
      this.collateralTokenDigestCache = normalizeHex32(this.env.collateralTokenDigest);
      return this.collateralTokenDigestCache;
    }
    if (!this.env.collateralTokenContract || !this.onchain?.enabled) {
      this.collateralTokenDigestCache = null;
      return undefined;
    }

    try {
      this.collateralTokenDigestCache = this.onchain.tokenDigest(this.env.collateralTokenContract);
      return this.collateralTokenDigestCache;
    } catch {
      this.collateralTokenDigestCache = null;
      return undefined;
    }
  }
}

function governanceReadinessIssues(env: ServerEnv): string[] {
  if (!env.protocolAdminRequired) return [];
  if (env.protocolAdminAddresses.length === 0) {
    return ["PROTOCOL_ADMIN_ADDRESSES is required for governed mutations"];
  }
  return [];
}

function intentRegistryReadinessIssues(env: ServerEnv): string[] {
  if (!env.intentRegistryOnchainRequired) return [];

  const issues: string[] = [];
  if (!env.stellarOnchainRelay) {
    issues.push("STELLAR_ONCHAIN_RELAY must be enabled for on-chain intent registry");
  }
  if (env.stellarRelayerMode !== "stellar-cli") {
    issues.push("STELLAR_RELAYER_MODE must be stellar-cli for submitted intent registry transactions");
  }
  return issues;
}

function conditionalOrderReadinessIssues(env: ServerEnv): string[] {
  if (!env.conditionalOrdersOnchainRequired) return [];

  const issues: string[] = [];
  if (!env.stellarOnchainRelay) {
    issues.push("STELLAR_ONCHAIN_RELAY must be enabled for on-chain conditional orders");
  }
  if (env.stellarRelayerMode !== "stellar-cli") {
    issues.push("STELLAR_RELAYER_MODE must be stellar-cli for submitted conditional order transactions");
  }
  return issues;
}

function settlementReadinessIssues(env: ServerEnv): string[] {
  if (!env.settlementsOnchainRequired) return [];

  const issues: string[] = [];
  if (!env.stellarOnchainRelay) {
    issues.push("STELLAR_ONCHAIN_RELAY must be enabled for on-chain settlement finality");
  }
  if (env.stellarRelayerMode !== "stellar-cli") {
    issues.push("STELLAR_RELAYER_MODE must be stellar-cli for submitted settlement transactions");
  }
  return issues;
}

function matchingReadinessIssues(env: ServerEnv): string[] {
  if (!env.privateMatchingRequired) return [];
  const issues: string[] = [];
  if (!env.matcherServiceUrl) {
    issues.push("MATCHER_SERVICE_URL is required for private matcher service");
  }
  return issues;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "<invalid>";
  }
}

function custodyReadinessIssues(env: ServerEnv): string[] {
  if (!env.assetCustodyRequired) return [];

  const issues: string[] = [];
  if (!env.collateralTokenContract) {
    issues.push("COLLATERAL_TOKEN_CONTRACT is required for asset custody");
  }
  if (!env.collateralTokenDigest && !env.stellarOnchainRelay) {
    issues.push("COLLATERAL_TOKEN_DIGEST or STELLAR_ONCHAIN_RELAY is required for asset custody proofs");
  }
  if (!env.stellarOnchainRelay) {
    issues.push("STELLAR_ONCHAIN_RELAY must be enabled for asset custody");
  }
  if (env.stellarRelayerMode !== "stellar-cli") {
    issues.push("STELLAR_RELAYER_MODE must be stellar-cli for live asset custody");
  }
  return issues;
}

function normalizeHex32(value: string): Hex {
  const match = value.trim().match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  if (!match) throw new Error("COLLATERAL_TOKEN_DIGEST must be bytes32 hex");
  return `0x${match[1].toLowerCase()}`;
}
