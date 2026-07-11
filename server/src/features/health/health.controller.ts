import { json } from "@/shared/http/json";
import { oracleReadinessIssues } from "@/shared/protocol/oracle";
import type { ServerEnv } from "@/config/env";
import type { Hex } from "@pnlx/protocol-types";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type {
  ProtocolPersistenceStatus,
} from "@/shared/mongo/store";

interface PersistenceStatusProvider {
  persistenceStatus(): ProtocolPersistenceStatus;
}

export class HealthController {
  private collateralTokenDigestCache?: Hex | null;

  constructor(
    private readonly env: ServerEnv,
    private readonly onchain?: Pick<OnchainRelayService, "enabled" | "tokenDigest">,
    private readonly persistence?: PersistenceStatusProvider,
  ) {}

  get(): Response {
    const persistenceStatus = this.persistence?.persistenceStatus();
    const custodyIssues = custodyReadinessIssues(this.env);
    const governanceIssues = governanceReadinessIssues(this.env);
    const intentRegistryIssues = intentRegistryReadinessIssues(this.env);
    const conditionalOrderIssues = conditionalOrderReadinessIssues(this.env);
    const settlementIssues = settlementReadinessIssues(this.env);
    const oracleIssues = oracleReadinessIssues(this.env);
    const matchingIssues = matchingReadinessIssues(this.env);
    return json({
      ok: persistenceStatus?.healthy ?? true,
      service: "pnlx-server",
      runtime: {
        clientStorageScope: clientStorageScope(this.env),
      },
      auth: {
        required: this.env.authRequired,
        restartSafeSessions: this.env.authSessionSecret.length >= 32,
        sessionMode: "signed-stateless",
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
        readinessScope: "configuration-only",
        liveVerifierAuthorityChecked: false,
        proofArtifactChecked: false,
        issues: settlementIssues,
      },
      funding: {
        enabled: this.env.fundingEngineEnabled,
        effective:
          this.env.fundingEngineEnabled &&
          (this.env.fundingPremiumMode === "impact-twap" || this.env.fundingPremiumRate !== 0n),
        impactMargin: this.env.fundingImpactMargin.toString(),
        intervalMs: this.env.fundingIntervalMs,
        minimumSamples: this.env.fundingMinimumSamples,
        premiumMode: this.env.fundingPremiumMode,
        premiumRate: this.env.fundingPremiumRate.toString(),
        premiumRateCap: this.env.fundingPremiumRateCap.toString(),
        sampleIntervalMs: this.env.fundingSampleIntervalMs,
        issues:
          this.env.fundingEngineEnabled &&
          this.env.fundingPremiumMode === "fixed" &&
          this.env.fundingPremiumRate === 0n
            ? ["FUNDING_PREMIUM_RATE is zero; automatic funding cycles will be skipped"]
            : [],
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
          boundless: {
            privateKeyConfigured: this.env.boundlessPrivateKeyConfigured,
            ipfsStorageConfigured: this.env.pinataJwtConfigured,
            rpcConfigured: this.env.boundlessRpcConfigured,
          },
          devMode: this.env.risc0DevMode,
          provider: this.env.matcherProvider,
          proofSystem: "risc0-groth16",
        },
        privateMatchingRequired: this.env.privateMatchingRequired,
        readyForPrivateMatching: matchingIssues.length === 0,
        readinessScope: "configuration-only",
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
        mongodb: {
          collection: this.env.mongodbCollection,
          database: this.env.mongodbDatabase,
          configured: Boolean(this.env.mongodbUri),
          format: persistenceStatus?.format,
          healthy: persistenceStatus?.healthy ?? Boolean(this.env.mongodbUri),
          version: persistenceStatus?.version,
          ...(persistenceStatus?.error ? { error: persistenceStatus.error } : {}),
        },
        protocolStore: Boolean(this.env.mongodbUri),
        workers: "direct",
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
  if (!env.boundlessRpcConfigured) {
    issues.push("BOUNDLESS_RPC_URL is required for RISC0 proving");
  }
  if (!env.boundlessPrivateKeyConfigured) {
    issues.push("BOUNDLESS_PRIVATE_KEY is required for RISC0 proving");
  }
  if (!env.pinataJwtConfigured) {
    issues.push("PINATA_JWT is required for durable Boundless proof artifacts");
  }
  if (env.risc0DevMode) {
    issues.push("RISC0_DEV_MODE must be disabled for production proving");
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

function clientStorageScope(env: ServerEnv): string {
  return [
    "pnlx",
    env.stellarNetwork,
    env.mongodbDatabase,
    env.mongodbCollection,
    env.stellarDeploymentFile,
    env.collateralTokenContract,
  ].filter(Boolean).join(":");
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
