import { json, readJson } from "../../shared/http/json";
import { Router } from "../../shared/http/router";
import { createExecutor } from "../executor/executor.worker";
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
  mpcNodeIds?: string[];
  mpcThreshold?: number;
  privateMatchingRequired?: boolean;
  signerConfig?: Parameters<typeof createExternalMatcher>[1];
  storePath?: string;
  token?: string;
}

export function createExternalMatcherApp(options: ExternalMatcherAppOptions = {}): Router {
  const computeBackend = options.computeBackend ?? "local-threshold";
  if (options.privateMatchingRequired && computeBackend !== "remote-blind") {
    throw new Error("MATCHER_COMPUTE_BACKEND=remote-blind is required for private matcher service");
  }
  if (computeBackend === "remote-blind" && !options.computeUrl) {
    throw new Error("MATCHER_COMPUTE_URL is required for remote blind matcher compute");
  }

  const router = new Router();
  const executor = createExecutor({
    matchingBackend: "external-blind",
    mpcNodeIds: options.mpcNodeIds,
    mpcThreshold: options.mpcThreshold,
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
