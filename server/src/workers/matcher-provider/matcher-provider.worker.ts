import { MatcherProviderService } from "@/workers/matcher-provider/matcher-provider.service";
import type { MatcherProviderConfig } from "@/workers/matcher-provider/matcher-provider.model";

export function createMatcherProvider(config: MatcherProviderConfig): MatcherProviderService {
  return new MatcherProviderService(config);
}
