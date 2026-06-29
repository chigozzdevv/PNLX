import type { ExecutorService } from "@/workers/executor/executor.service";
import { MatcherService } from "@/workers/matcher/matcher.service";
import type { MatcherConfig } from "@/workers/matcher/matcher.model";

export function createMatcher(
  executor: ExecutorService,
  config: MatcherConfig = {},
): MatcherService {
  return new MatcherService(executor.store, executor.committee, undefined, config);
}
