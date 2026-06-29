import { RelayerService } from "./relayer.service";
import type { CommandRunner, StellarRelayerConfig } from "./relayer.model";

interface CreateRelayerOptions {
  config?: StellarRelayerConfig;
  historyPath?: string;
  runCommand?: CommandRunner;
}

export function createRelayer(options: CreateRelayerOptions = {}): RelayerService {
  return new RelayerService(options.config, options.runCommand, options.historyPath);
}
