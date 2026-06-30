import { json } from "@/shared/http/json";
import { oracleReadinessIssues } from "@/shared/protocol/oracle";
import type { ServerEnv } from "@/config/env";

export class HealthController {
  constructor(private readonly env: ServerEnv) {}

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
      service: "merkl-server",
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
        backend: this.env.matchingBackend,
        matcherService: {
          configured: Boolean(this.env.matcherServiceUrl),
          url: this.env.matcherServiceUrl ? redactUrl(this.env.matcherServiceUrl) : "",
        },
        provider: {
          backend: this.env.matcherProvider,
          configured: Boolean(this.env.matcherProviderUrl),
          url: this.env.matcherProviderUrl ? redactUrl(this.env.matcherProviderUrl) : "",
        },
        nilcc: {
          attestationPinned: Boolean(
            this.env.nilccAttestationReportSha256 ||
              this.env.nilccAttestationContains.length > 0,
          ),
          attestationRequired: this.env.nilccAttestationRequired,
          configured: Boolean(this.env.nilccWorkloadUrl),
          workloadUrl: this.env.nilccWorkloadUrl ? redactUrl(this.env.nilccWorkloadUrl) : "",
        },
        thresholdShares: {
          nodeIds: this.env.thresholdShareNodeIds,
          threshold: this.env.thresholdShareThreshold,
        },
        matcherCommittee: {
          addressCount: this.env.matcherCommitteeAddresses.length,
          required: this.env.matcherCommitteeRequired,
          threshold: this.env.matcherCommitteeThreshold,
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
        protocolStore: Boolean(this.env.protocolStorePath),
        relayStore: Boolean(this.env.relayStorePath),
      },
      stellar: {
        network: this.env.stellarNetwork,
        networkPassphrase: this.env.stellarNetworkPassphrase,
        onchainRelayEnabled: this.env.stellarOnchainRelay,
        relayerMode: this.env.stellarRelayerMode,
      },
    });
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
  if (!env.privateMatchingRequired && !env.matcherCommitteeRequired) return [];
  const issues: string[] = [];
  if (env.matchingBackend === "threshold-recovery") {
    issues.push("MATCHING_BACKEND=threshold-recovery is not executor-blind");
  }
  if (env.matchingBackend === "external-blind" && env.privateMatchingRequired && !env.matcherServiceUrl) {
    issues.push("MATCHER_SERVICE_URL is required for private matcher service");
  }
  if (env.privateMatchingRequired && env.matcherProvider === "embedded") {
    issues.push("MATCHER_PROVIDER=custom or nilcc is required for private matcher service");
  }
  if (env.privateMatchingRequired && env.matcherProvider === "custom" && !env.matcherProviderUrl) {
    issues.push("MATCHER_PROVIDER_URL is required for custom matcher provider");
  }
  if (env.privateMatchingRequired && env.matcherProvider === "nilcc" && !env.nilccWorkloadUrl) {
    issues.push("NILCC_WORKLOAD_URL is required for nilCC matcher provider");
  }
  if (
    env.privateMatchingRequired &&
    env.matcherProvider === "nilcc" &&
    env.nilccAttestationRequired &&
    !env.nilccAttestationReportSha256 &&
    env.nilccAttestationContains.length === 0
  ) {
    issues.push("NILCC_ATTESTATION_REPORT_SHA256 or NILCC_ATTESTATION_CONTAINS is required for nilCC matcher provider");
  }
  if (env.matcherCommitteeRequired && env.matcherCommitteeThreshold < 1) {
    issues.push("MATCHER_COMMITTEE_THRESHOLD must be at least 1");
  }
  if (
    env.matcherCommitteeRequired &&
    env.matcherCommitteeAddresses.length < env.matcherCommitteeThreshold
  ) {
    issues.push("MATCHER_COMMITTEE_ADDRESSES must include at least MATCHER_COMMITTEE_THRESHOLD signers");
  }
  if (env.thresholdShareThreshold < 2) {
    issues.push("THRESHOLD_SHARE_THRESHOLD must be at least 2");
  }
  if (env.thresholdShareNodeIds.length < env.thresholdShareThreshold) {
    issues.push("THRESHOLD_SHARE_NODE_IDS must include at least THRESHOLD_SHARE_THRESHOLD nodes");
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
  if (!env.stellarOnchainRelay) {
    issues.push("STELLAR_ONCHAIN_RELAY must be enabled for asset custody");
  }
  if (env.stellarRelayerMode !== "stellar-cli") {
    issues.push("STELLAR_RELAYER_MODE must be stellar-cli for live asset custody");
  }
  return issues;
}
