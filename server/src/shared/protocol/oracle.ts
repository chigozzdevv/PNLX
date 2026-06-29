import type { ServerEnv } from "@/config/env";

export function oracleReadinessIssues(
  env: ServerEnv,
  options: { requireOnchain?: boolean } = {},
): string[] {
  const onchainRequired = options.requireOnchain || env.stellarOnchainRelay || env.oracleOnchainRequired;
  const issues: string[] = [];
  if (env.oracleOnchainRequired && env.oraclePriceSource !== "onchain-market") {
    issues.push("ORACLE_PRICE_SOURCE=onchain-market is required for production oracle authority");
  }
  if (
    (env.oracleOnchainRequired || env.oraclePriceSource === "onchain-market") &&
    !env.stellarOnchainRelay
  ) {
    issues.push("STELLAR_ONCHAIN_RELAY must be enabled for on-chain oracle reads");
  }
  if (!onchainRequired) return issues;

  if (!env.oracleContractId) {
    issues.push("ORACLE_CONTRACT_ID is required for on-chain oracle settlement");
  }
  if (env.oraclePriceSource === "onchain-market") return issues;

  if (env.oraclePublishMode !== "committee") {
    issues.push("ORACLE_PUBLISH_MODE=committee is required for production oracle publishing");
    return issues;
  }
  if (env.oracleCommitteeThreshold < 2) {
    issues.push("ORACLE_COMMITTEE_THRESHOLD must be at least 2");
  }
  if (env.oraclePublisherAddresses.length < env.oracleCommitteeThreshold) {
    issues.push("ORACLE_PUBLISHER_ADDRESSES must include at least ORACLE_COMMITTEE_THRESHOLD publishers");
  }
  if (env.oraclePublisherSources.length < env.oraclePublisherAddresses.length) {
    issues.push("ORACLE_PUBLISHER_SOURCES must include one source for each publisher address");
  }
  return issues;
}

export function assertOracleReadyForOnchain(env: ServerEnv): void {
  const issues = oracleReadinessIssues(env, { requireOnchain: true });
  if (issues.length > 0) throw new Error(`oracle not ready for on-chain settlement: ${issues[0]}`);
}

export function assertOracleAuthorityReady(env: ServerEnv): void {
  if (!env.oracleOnchainRequired) return;
  const issues = oracleReadinessIssues(env, { requireOnchain: true });
  if (issues.length > 0) throw new Error(`oracle not ready for production authority: ${issues[0]}`);
}
