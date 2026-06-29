import type { ExecutorService } from "../executor/executor.service";
import { ExternalMatcherService } from "./external-matcher.service";
import type { ExternalMatcherConfig } from "./external-matcher.model";

export function createExternalMatcher(
  executor: ExecutorService,
  config: ExternalMatcherConfig = {},
): ExternalMatcherService {
  return new ExternalMatcherService(executor.store, executor.committee, undefined, config);
}
