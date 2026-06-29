import type { ExecutorService } from "../executor/executor.service";
import { MatcherService } from "./matcher.service";
import type { MatcherConfig } from "./matcher.model";

export function createMatcher(
  executor: ExecutorService,
  config: MatcherConfig = {},
): MatcherService {
  return new MatcherService(executor.store, executor.committee, undefined, config);
}
