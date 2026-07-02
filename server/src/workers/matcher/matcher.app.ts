import { json, readJson } from "@/shared/http/json";
import { Router } from "@/shared/http/router";
import { createExecutor } from "@/workers/executor/executor.worker";
import { createMatcher } from "@/workers/matcher/matcher.worker";
import type {
  CreateExternalSettlementInput,
  MatcherProvider,
} from "@/workers/matcher/matcher.model";

export interface MatcherAppOptions {
  provider?: MatcherProvider;
  thresholdShareNodeIds?: string[];
  thresholdShareStoreDir?: string;
  thresholdShareThreshold?: number;
  privateMatchingRequired?: boolean;
  signerConfig?: Parameters<typeof createMatcher>[1];
  storePath?: string;
  token?: string;
}

export function createMatcherApp(options: MatcherAppOptions = {}): Router {
  const provider = options.provider ?? "risc0";

  const router = new Router();
  const persistentMatcher = options.storePath ? undefined : createRequestMatcher(options, provider);

  router.add("POST", "/match/settlement", async (request) => {
    assertMatcherAuth(request, options.token);
    const input = await readJson<CreateExternalSettlementInput>(request);
    const matcher = persistentMatcher ?? createRequestMatcher(options, provider);
    return json(await matcher.createSettlementTranscript(input), 201);
  }, { public: true });

  return router;
}

function createRequestMatcher(
  options: MatcherAppOptions,
  _provider: MatcherProvider,
) {
  const executor = createExecutor({
    matchingBackend: "external-blind",
    thresholdShareNodeIds: options.thresholdShareNodeIds,
    thresholdShareStoreDir: options.thresholdShareStoreDir,
    thresholdShareThreshold: options.thresholdShareThreshold,
    privateMatchingRequired: true,
    storePath: options.storePath,
  });
  return createMatcher(executor, options.signerConfig);
}

function assertMatcherAuth(request: Request, token: string | undefined): void {
  if (!token) return;
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${token}`) {
    throw new Error("invalid matcher api token");
  }
}
