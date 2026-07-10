import { json, readJson } from "@/shared/http/json";
import { Router } from "@/shared/http/router";
import { createExecutor, createExecutorAsync } from "@/workers/executor/executor.worker";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { MongoProtocolStoreOptions } from "@/shared/state/mongo-store";
import { createMatcher } from "@/workers/matcher/matcher.worker";
import { MatcherJobService } from "@/workers/matcher/matcher-job.service";
import type {
  CreateExternalSettlementInput,
  MatcherGateway,
  MatcherProvider,
} from "@/workers/matcher/matcher.model";

export interface MatcherAppOptions {
  executor?: ExecutorService;
  provider?: MatcherProvider;
  privateMatchingRequired?: boolean;
  signerConfig?: Parameters<typeof createMatcher>[1];
  mongo?: MongoProtocolStoreOptions;
  token?: string;
}

export function createMatcherApp(options: MatcherAppOptions = {}): Router {
  const provider = options.provider ?? "risc0";

  const router = new Router();
  const persistentMatcher = createRequestMatcher(options, provider);
  const jobs = MatcherJobService.memory((input) =>
    Promise.resolve(persistentMatcher.createSettlementTranscript(input))
  );

  router.add("POST", "/match/jobs", async (request) => {
    assertMatcherAuth(request, options.token);
    return json(await jobs.enqueue(await readJson<CreateExternalSettlementInput>(request)), 202);
  }, { public: true });
  router.add("GET", "/match/jobs", async (request) => {
    assertMatcherAuth(request, options.token);
    const jobId = new URL(request.url).searchParams.get("id");
    if (!jobId) throw new Error("matcher job id is required");
    return json(await jobs.get(jobId));
  }, { public: true });

  router.add("POST", "/match/settlement", async (request) => {
    assertMatcherAuth(request, options.token);
    const input = await readJson<CreateExternalSettlementInput>(request);
    const matcher = persistentMatcher ?? createRequestMatcher(options, provider);
    return json(await matcher.createSettlementTranscript(input), 201);
  }, { public: true });

  return router;
}

export async function createMatcherAppAsync(options: MatcherAppOptions = {}): Promise<Router> {
  const provider = options.provider ?? "risc0";

  const router = new Router();
  const persistentMatcher = options.mongo ? undefined : await createRequestMatcherRuntimeAsync(options, provider);
  const processJob = async (input: CreateExternalSettlementInput) => {
    const runtime = persistentMatcher ?? await createRequestMatcherRuntimeAsync(options, provider);
    try {
      return await runtime.matcher.createSettlementTranscript(input);
    } finally {
      if (!persistentMatcher) await runtime.close?.();
    }
  };
  const jobs = options.mongo
    ? await MatcherJobService.connect(options.mongo, processJob)
    : MatcherJobService.memory(processJob);

  router.add("POST", "/match/jobs", async (request) => {
    assertMatcherAuth(request, options.token);
    return json(await jobs.enqueue(await readJson<CreateExternalSettlementInput>(request)), 202);
  }, { public: true });
  router.add("GET", "/match/jobs", async (request) => {
    assertMatcherAuth(request, options.token);
    const jobId = new URL(request.url).searchParams.get("id");
    if (!jobId) throw new Error("matcher job id is required");
    return json(await jobs.get(jobId));
  }, { public: true });

  router.add("POST", "/match/settlement", async (request) => {
    assertMatcherAuth(request, options.token);
    const input = await readJson<CreateExternalSettlementInput>(request);
    const runtime = persistentMatcher ?? await createRequestMatcherRuntimeAsync(options, provider);
    try {
      return json(await runtime.matcher.createSettlementTranscript(input), 201);
    } finally {
      await runtime.close?.();
    }
  }, { public: true });

  return router;
}

function createRequestMatcher(
  options: MatcherAppOptions,
  _provider: MatcherProvider,
) {
  const executor = options.executor ?? createExecutor({
    privateMatchingRequired: true,
  });
  return createMatcher(executor, options.signerConfig);
}

async function createRequestMatcherRuntimeAsync(
  options: MatcherAppOptions,
  _provider: MatcherProvider,
) : Promise<{ close?: () => Promise<void>; matcher: MatcherGateway }> {
  const executor = options.executor ?? await createExecutorAsync({
    mongo: options.mongo,
    privateMatchingRequired: true,
  });
  const closeableStore = hasClose(executor.store) ? executor.store : undefined;
  return {
    close: closeableStore ? () => closeableStore.close() : undefined,
    matcher: createMatcher(executor, options.signerConfig),
  };
}

function hasClose(value: unknown): value is { close(): Promise<void> } {
  return Boolean(value && typeof value === "object" && "close" in value && typeof value.close === "function");
}

function assertMatcherAuth(request: Request, token: string | undefined): void {
  if (!token) return;
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${token}`) {
    throw new Error("invalid matcher api token");
  }
}
