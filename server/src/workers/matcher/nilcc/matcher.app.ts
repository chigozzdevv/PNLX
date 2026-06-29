import { NilccBlindComputeClient } from "./matcher.service";

export interface NilccMatcherOptions {
  computeToken?: string;
  nilccAttestationContains?: string[];
  nilccAttestationReportSha256?: string;
  nilccAttestationReportUrl?: string;
  nilccAttestationRequired?: boolean;
  nilccAttestationToken?: string;
  nilccWorkloadUrl?: string;
}

export function createNilccMatcherCompute(options: NilccMatcherOptions): NilccBlindComputeClient {
  assertNilccMatcherConfig(options);
  return new NilccBlindComputeClient({
    attestationContains: options.nilccAttestationContains ?? [],
    attestationReportSha256: options.nilccAttestationReportSha256,
    attestationReportUrl: options.nilccAttestationReportUrl,
    attestationRequired: options.nilccAttestationRequired ?? true,
    attestationToken: options.nilccAttestationToken,
    token: options.computeToken,
    workloadUrl: options.nilccWorkloadUrl ?? "",
  });
}

export function assertNilccMatcherConfig(options: NilccMatcherOptions): void {
  if (!options.nilccWorkloadUrl) {
    throw new Error("NILCC_WORKLOAD_URL is required for nilCC blind compute");
  }
  if (
    (options.nilccAttestationRequired ?? true) &&
    !options.nilccAttestationReportSha256 &&
    (options.nilccAttestationContains ?? []).length === 0
  ) {
    throw new Error("NILCC_ATTESTATION_REPORT_SHA256 or NILCC_ATTESTATION_CONTAINS is required for nilCC blind compute");
  }
}
