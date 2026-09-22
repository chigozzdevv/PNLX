import { loadEnv } from "@/config/env";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import { recordVaultMakerAllocation } from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { assertSuccessfulTransaction } from "./register-vault-maker-note";

if (import.meta.main) {
  await allocate(process.argv.slice(2));
}

export async function allocate(argv: string[]): Promise<void> {
  const amount = requiredArg(argv, "--amount");
  const operatorSource = requiredArg(argv, "--operator-source");
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("amount must be positive base units");
  const value = BigInt(amount);

  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || env.stellarRelayerMode !== "stellar-cli" ||
    !env.stellarOnchainRelay || !env.makerWalletAddress || !env.collateralTokenContract) {
    throw new Error("Testnet vault maker, Stellar relay, and collateral token are required");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  const vaultId = deployment?.contracts["liquidity-vault"];
  if (!vaultId) throw new Error("liquidity vault deployment is required");

  const relayer = createRelayer({ config: {
    commandTimeoutMs: env.stellarCommandTimeoutMs,
    mode: "stellar-cli",
    network: env.stellarNetwork,
    networkPassphrase: env.stellarNetworkPassphrase,
    rpcUrl: env.stellarRpcUrl,
    source: operatorSource,
  } });
  const vaultService = new LiquidityVaultService(relayer, deployment);
  const before = await vaultService.status();
  const maker = env.makerWalletAddress.trim().toUpperCase();
  if (before.contractId !== vaultId || before.asset !== env.collateralTokenContract ||
    before.maker !== maker || !before.paused || BigInt(before.totalShares) === 0n ||
    BigInt(before.liquidAssets) < value ||
    BigInt(before.deployedPrincipal) + value >
      BigInt(before.totalAssetsAtCost) * BigInt(before.allocationLimitBps) / 10_000n) {
    throw new Error("vault is not ready to allocate this amount to its configured maker");
  }
  const balanceBefore = await tokenBalance();
  const tx = await relayer.relayAsync({
    kind: "contract-invoke",
    payload: {
      args: ["--amount", amount],
      contractId: vaultId,
      functionName: "allocate",
      send: "yes",
      source: operatorSource,
    },
  });
  if (!tx.txHash || !tx.submitted) throw new Error("vault allocation did not return a submitted transaction");
  process.stdout.write(`${JSON.stringify({ allocationTxHash: tx.txHash, status: "submitted" })}\n`);

  const allocationLedger = await assertSuccessfulTransaction(env.stellarRpcUrl, tx.txHash);
  const after = await vaultService.status();
  const balanceAfter = await tokenBalance();
  if (after.asset !== before.asset || after.maker !== before.maker || !after.paused ||
    BigInt(after.deployedPrincipal) - BigInt(before.deployedPrincipal) !== value ||
    BigInt(before.liquidAssets) - BigInt(after.liquidAssets) !== value ||
    balanceAfter - balanceBefore !== value) {
    throw new Error(`allocation ${tx.txHash} was submitted but vault and maker balance changes did not reconcile`);
  }

  const allocation = await recordVaultMakerAllocation({
    allocationLedger,
    allocationTxHash: tx.txHash,
    amount,
    asset: before.asset,
    maker,
    vault: vaultId,
  });
  process.stdout.write(`${JSON.stringify({ allocationId: allocation.id, allocationTxHash: tx.txHash,
    amount, status: "recorded" })}\n`);

  async function tokenBalance(): Promise<bigint> {
    const result = await relayer.readAsync({
      kind: "contract-invoke",
      payload: {
        args: ["--id", maker],
        contractId: env.collateralTokenContract!,
        functionName: "balance",
        send: "no",
      },
    });
    const raw = result.output.trim();
    const parsed = raw.startsWith('"') ? String(JSON.parse(raw)) : raw;
    if (!/^-?[0-9]+$/.test(parsed)) throw new Error("invalid maker token balance response");
    return BigInt(parsed);
  }
}

function requiredArg(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
