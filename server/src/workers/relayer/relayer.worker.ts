import { RelayerService } from "@/workers/relayer/relayer.service";
import type { CommandRunner, StellarRelayerConfig } from "@/workers/relayer/relayer.model";

interface CreateRelayerOptions {
  config?: StellarRelayerConfig;
  historyPath?: string;
  runCommand?: CommandRunner;
}

export function createRelayer(options: CreateRelayerOptions = {}): RelayerService {
  return new RelayerService(options.config, options.runCommand, options.historyPath);
}
