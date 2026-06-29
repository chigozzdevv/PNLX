import type { RelayerService } from "../relayer/relayer.service";
import type { OnchainRelayConfig } from "./onchain.model";
import { OnchainRelayService } from "./onchain.service";

export function createOnchainRelay(
  relayer: RelayerService,
  config: OnchainRelayConfig,
): OnchainRelayService {
  return new OnchainRelayService(relayer, config);
}
