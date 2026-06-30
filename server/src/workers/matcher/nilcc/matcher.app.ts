import { NilccMatcherProviderClient } from "@/workers/matcher/nilcc/matcher.service";

export interface NilccMatcherOptions {
  providerToken?: string;
  nilccAttestationContains?: string[];
  nilccAttestationReportSha256?: string;
  nilccAttestationReportUrl?: string;
  nilccAttestationRequired?: boolean;
  nilccAttestationToken?: string;
  nilccWorkloadUrl?: string;
}

export function createNilccMatcherProvider(options: NilccMatcherOptions): NilccMatcherProviderClient {
  assertNilccMatcherConfig(options);
  return new NilccMatcherProviderClient({
    attestationContains: options.nilccAttestationContains ?? [],
    attestationReportSha256: options.nilccAttestationReportSha256,
    attestationReportUrl: options.nilccAttestationReportUrl,
    attestationRequired: options.nilccAttestationRequired ?? true,
    attestationToken: options.nilccAttestationToken,
    token: options.providerToken,
    workloadUrl: options.nilccWorkloadUrl ?? "",
  });
}

export function assertNilccMatcherConfig(options: NilccMatcherOptions): void {
  if (!options.nilccWorkloadUrl) {
    throw new Error("NILCC_WORKLOAD_URL is required for nilCC matcher provider");
  }
  if (
    (options.nilccAttestationRequired ?? true) &&
    !options.nilccAttestationReportSha256 &&
    (options.nilccAttestationContains ?? []).length === 0
  ) {
    throw new Error("NILCC_ATTESTATION_REPORT_SHA256 or NILCC_ATTESTATION_CONTAINS is required for nilCC matcher provider");
  }
}
