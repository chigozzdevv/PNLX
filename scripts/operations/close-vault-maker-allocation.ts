import { loadEnv } from "@/config/env";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import {
  allocationId,
  closeVaultMakerAllocation,
} from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createRelayer } from "@/workers/relayer/relayer.worker";

if (import.meta.main) {
  const flagIndex = process.argv.indexOf("--allocation-tx");
  const txHash = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  if (!txHash || txHash.startsWith("--")) throw new Error("--allocation-tx requires a hash");
  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || env.stellarRelayerMode !== "stellar-cli") {
    throw new Error("Testnet Stellar relay is required");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  const vaultId = deployment?.contracts["liquidity-vault"];
  if (!vaultId) throw new Error("liquidity vault deployment is required");
  const relayer = createRelayer({
    config: {
      commandTimeoutMs: env.stellarCommandTimeoutMs,
      mode: "stellar-cli",
      network: env.stellarNetwork,
      networkPassphrase: env.stellarNetworkPassphrase,
      rpcUrl: env.stellarRpcUrl,
      source: env.stellarSource,
    },
  });
  const vault = await new LiquidityVaultService(relayer, deployment).status();
  if (vault.deployedPrincipal !== "0") throw new Error("vault allocation is still deployed");
  const id = allocationId(vaultId, txHash);
  await closeVaultMakerAllocation(id);
  process.stdout.write(`${JSON.stringify({ allocationId: id, status: "closed" })}\n`);
}
