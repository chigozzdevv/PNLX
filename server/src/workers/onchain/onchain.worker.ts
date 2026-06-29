import type { RelayerService } from "@/workers/relayer/relayer.service";
import type { OnchainRelayConfig } from "@/workers/onchain/onchain.model";
import { OnchainRelayService } from "@/workers/onchain/onchain.service";

export function createOnchainRelay(
  relayer: RelayerService,
  config: OnchainRelayConfig,
): OnchainRelayService {
  return new OnchainRelayService(relayer, config);
}
