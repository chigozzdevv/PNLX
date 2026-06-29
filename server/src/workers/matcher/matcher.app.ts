import { json, readJson } from "@/shared/http/json";
import { Router } from "@/shared/http/router";
import { createExecutor } from "@/workers/executor/executor.worker";
import { assertNilccMatcherConfig, createNilccMatcherCompute } from "@/workers/matcher/nilcc/matcher.app";
import { RemoteBlindComputeClient } from "@/workers/matcher/remote-compute/matcher.service";
import { createMatcher } from "@/workers/matcher/matcher.worker";
import type {
  BlindComputeGateway,
  CreateExternalSettlementInput,
  MatcherComputeBackend,
} from "@/workers/matcher/matcher.model";

export interface MatcherAppOptions {
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
  signerConfig?: Parameters<typeof createMatcher>[1];
  storePath?: string;
  token?: string;
}

export function createMatcherApp(options: MatcherAppOptions = {}): Router {
  const computeBackend = options.computeBackend ?? "local-threshold";
  if (options.privateMatchingRequired && computeBackend === "local-threshold") {
    throw new Error("MATCHER_COMPUTE_BACKEND=remote-blind or nilcc is required for private matcher service");
  }
  if (computeBackend === "remote-blind" && !options.computeUrl) {
    throw new Error("MATCHER_COMPUTE_URL is required for remote blind matcher compute");
  }
  if (computeBackend === "nilcc") {
    assertNilccMatcherConfig(options);
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
  const matcher = createMatcher(executor, {
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
  options: MatcherAppOptions,
  backend: MatcherComputeBackend,
): BlindComputeGateway | undefined {
  if (backend === "local-threshold") return undefined;
  if (backend === "nilcc") {
    return createNilccMatcherCompute(options);
  }
  return new RemoteBlindComputeClient({
    token: options.computeToken,
    url: options.computeUrl ?? "",
  });
}

function assertMatcherAuth(request: Request, token: string | undefined): void {
  if (!token) return;
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${token}`) {
    throw new Error("invalid matcher api token");
  }
}
