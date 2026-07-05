import { RelayerService } from "@/workers/relayer/relayer.service";
import type { CommandRunner, StellarRelayerConfig } from "@/workers/relayer/relayer.model";

interface CreateRelayerOptions {
  config?: StellarRelayerConfig;
  runCommand?: CommandRunner;
}

export function createRelayer(options: CreateRelayerOptions = {}): RelayerService {
  return new RelayerService(options.config, options.runCommand);
}
