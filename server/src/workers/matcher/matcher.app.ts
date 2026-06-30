import { json, readJson } from "@/shared/http/json";
import { Router } from "@/shared/http/router";
import { createExecutor } from "@/workers/executor/executor.worker";
import { assertNilccMatcherConfig, createNilccMatcherProvider } from "@/workers/matcher/nilcc/matcher.app";
import { CustomMatcherProviderClient } from "@/workers/matcher/custom/matcher.service";
import { assertMpspdzMatcherConfig, createMpspdzMatcherProvider } from "@/workers/matcher/mpspdz/matcher.app";
import { createMatcher } from "@/workers/matcher/matcher.worker";
import type {
  MatcherProviderGateway,
  CreateExternalSettlementInput,
  MatcherProvider,
} from "@/workers/matcher/matcher.model";

export interface MatcherAppOptions {
  provider?: MatcherProvider;
  providerToken?: string;
  providerUrl?: string;
  mpspdzCoordinatorUrl?: string;
  mpspdzPartyUrls?: string[];
  mpspdzProtocol?: string;
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
  const provider = options.provider ?? "embedded";
  if (options.privateMatchingRequired && provider === "embedded") {
    throw new Error("MATCHER_PROVIDER=custom, mpspdz, or nilcc is required for private matcher service");
  }
  if (provider === "custom" && !options.providerUrl) {
    throw new Error("MATCHER_PROVIDER_URL is required for custom matcher provider");
  }
  if (provider === "mpspdz") {
    assertMpspdzMatcherConfig(options);
  }
  if (provider === "nilcc") {
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
    provider: options.signerConfig?.provider ?? providerFor(options, provider),
  });

  router.add("POST", "/match/settlement", async (request) => {
    assertMatcherAuth(request, options.token);
    const input = await readJson<CreateExternalSettlementInput>(request);
    return json(await matcher.createSettlementTranscript(input), 201);
  }, { public: true });

  return router;
}

function providerFor(
  options: MatcherAppOptions,
  backend: MatcherProvider,
): MatcherProviderGateway | undefined {
  if (backend === "embedded") return undefined;
  if (backend === "mpspdz") {
    return createMpspdzMatcherProvider(options);
  }
  if (backend === "nilcc") {
    return createNilccMatcherProvider(options);
  }
  return new CustomMatcherProviderClient({
    token: options.providerToken,
    url: options.providerUrl ?? "",
  });
}

function assertMatcherAuth(request: Request, token: string | undefined): void {
  if (!token) return;
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${token}`) {
    throw new Error("invalid matcher api token");
  }
}
