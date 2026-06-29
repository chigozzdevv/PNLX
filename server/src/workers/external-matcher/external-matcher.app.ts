import { json, readJson } from "../../shared/http/json";
import { Router } from "../../shared/http/router";
import { createExecutor } from "../executor/executor.worker";
import { NilccBlindComputeClient } from "./nilcc-blind-compute.service";
import { RemoteBlindComputeClient } from "./remote-blind-compute.service";
import { createExternalMatcher } from "./external-matcher.worker";
import type {
  BlindComputeGateway,
  CreateExternalSettlementInput,
  MatcherComputeBackend,
} from "./external-matcher.model";

export interface ExternalMatcherAppOptions {
  computeBackend?: MatcherComputeBackend;
  computeToken?: string;
  computeUrl?: string;
  nilccAttestationContains?: string[];
  nilccAttestationReportSha256?: string;
  nilccAttestationReportUrl?: string;
  nilccAttestationRequired?: boolean;
  nilccAttestationToken?: string;
  nilccWorkloadUrl?: string;
  thresholdShareNodeIds?: string[];
  thresholdShareStoreDir?: string;
  thresholdShareThreshold?: number;
  privateMatchingRequired?: boolean;
  signerConfig?: Parameters<typeof createExternalMatcher>[1];
  storePath?: string;
  token?: string;
}

export function createExternalMatcherApp(options: ExternalMatcherAppOptions = {}): Router {
  const computeBackend = options.computeBackend ?? "local-threshold";
  if (options.privateMatchingRequired && computeBackend === "local-threshold") {
    throw new Error("MATCHER_COMPUTE_BACKEND=remote-blind or nilcc is required for private matcher service");
  }
  if (computeBackend === "remote-blind" && !options.computeUrl) {
    throw new Error("MATCHER_COMPUTE_URL is required for remote blind matcher compute");
  }
  if (computeBackend === "nilcc") {
    assertNilccConfig(options);
  }

  const router = new Router();
  const executor = createExecutor({
    matchingBackend: "external-blind",
    thresholdShareNodeIds: options.thresholdShareNodeIds,
    thresholdShareStoreDir: options.thresholdShareStoreDir,
    thresholdShareThreshold: options.thresholdShareThreshold,
    privateMatchingRequired: true,
    storePath: options.storePath,
  });
  const matcher = createExternalMatcher(executor, {
    ...options.signerConfig,
    compute: options.signerConfig?.compute ?? computeFor(options, computeBackend),
  });

  router.add("POST", "/match/settlement", async (request) => {
    assertMatcherAuth(request, options.token);
    const input = await readJson<CreateExternalSettlementInput>(request);
    return json(await matcher.createSettlementTranscript(input), 201);
  }, { public: true });

  return router;
}

function computeFor(
  options: ExternalMatcherAppOptions,
  backend: MatcherComputeBackend,
): BlindComputeGateway | undefined {
  if (backend === "local-threshold") return undefined;
  if (backend === "nilcc") {
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
  return new RemoteBlindComputeClient({
    token: options.computeToken,
    url: options.computeUrl ?? "",
  });
}

function assertNilccConfig(options: ExternalMatcherAppOptions): void {
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

function assertMatcherAuth(request: Request, token: string | undefined): void {
  if (!token) return;
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${token}`) {
    throw new Error("invalid matcher api token");
  }
}
