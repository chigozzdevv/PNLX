import { MpspdzMatcherProviderClient } from "@/workers/matcher/mpspdz/matcher.service";

export interface MpspdzMatcherOptions {
  mpspdzCoordinatorUrl?: string;
  mpspdzPartyUrls?: string[];
  mpspdzProtocol?: string;
  providerToken?: string;
}

export function createMpspdzMatcherProvider(
  options: MpspdzMatcherOptions,
): MpspdzMatcherProviderClient {
  assertMpspdzMatcherConfig(options);
  return new MpspdzMatcherProviderClient({
    coordinatorUrl: options.mpspdzCoordinatorUrl ?? "",
    partyUrls: options.mpspdzPartyUrls ?? [],
    protocol: options.mpspdzProtocol ?? "replicated-ring",
    token: options.providerToken,
  });
}

export function assertMpspdzMatcherConfig(options: MpspdzMatcherOptions): void {
  if (!options.mpspdzCoordinatorUrl) {
    throw new Error("MPSPDZ_COORDINATOR_URL is required for MP-SPDZ matcher provider");
  }
  if ((options.mpspdzPartyUrls ?? []).length < 3) {
    throw new Error("MPSPDZ_PARTY_URLS must include at least 3 party URLs for MP-SPDZ matcher provider");
  }
}
