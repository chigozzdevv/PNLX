import { loadEnv } from "@/config/env";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import { readVaultMakerAllocations, recordVaultMakerAllocation, type VaultMakerAllocation } from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { assertSuccessfulTransaction } from "./register-vault-maker-note";

if (import.meta.main) {
  await allocate(process.argv.slice(2));
}

export async function allocate(argv: string[]): Promise<VaultMakerAllocation> {
  const amount = requiredArg(argv, "--amount");
  const operatorSource = requiredArg(argv, "--operator-source");
  const seriesArg = optionalArg(argv, "--series");
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
  const series = seriesArg === undefined ? before.currentSeries : Number(seriesArg);
  if (!Number.isSafeInteger(series) || series < 0 || series > before.currentSeries) {
    throw new Error("series must be an existing vault series");
  }
  const seriesBefore = await readSeries();
  const outstanding = (await readVaultMakerAllocations())
    .filter((record) => record.vault === vaultId && record.series === series && record.status === "outstanding")
    .reduce((sum, record) => sum + BigInt(record.amount), 0n);
  if (before.contractId !== vaultId || before.asset !== env.collateralTokenContract ||
    before.maker !== maker || outstanding !== seriesBefore.principal ||
    seriesBefore.pending !== 0n || seriesBefore.shares === 0n || seriesBefore.liquid < value ||
    BigInt(before.deployedPrincipal) + value >
      BigInt(before.totalAssetsAtCost) * BigInt(before.allocationLimitBps) / 10_000n ||
    seriesBefore.principal + value >
      (seriesBefore.principal + seriesBefore.liquid) * BigInt(before.allocationLimitBps) / 10_000n) {
    throw new Error("vault is not ready to allocate this amount to its configured maker");
  }
  const balanceBefore = await tokenBalance();
  const tx = await relayer.relayAsync({
    kind: "contract-invoke",
    payload: {
      args: ["--series", String(series), "--amount", amount],
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
  const seriesAfter = await readSeries();
  const balanceAfter = await tokenBalance();
  if (after.asset !== before.asset || after.maker !== before.maker ||
    BigInt(after.deployedPrincipal) - BigInt(before.deployedPrincipal) !== value ||
    BigInt(before.liquidAssets) - BigInt(after.liquidAssets) !== value ||
    seriesAfter.principal - seriesBefore.principal !== value ||
    seriesBefore.liquid - seriesAfter.liquid !== value ||
    balanceAfter - balanceBefore !== value) {
    throw new Error(`allocation ${tx.txHash} was submitted but vault and maker balance changes did not reconcile`);
  }

  const allocation = await recordVaultMakerAllocation({
    allocationLedger,
    allocationTxHash: tx.txHash,
    amount,
    asset: before.asset,
    maker,
    series,
    vault: vaultId,
  });
  process.stdout.write(`${JSON.stringify({ allocationId: allocation.id, allocationTxHash: tx.txHash,
    amount, status: "recorded" })}\n`);
  return allocation;

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

  async function readSeries(): Promise<{ liquid: bigint; pending: bigint; principal: bigint; shares: bigint }> {
    const values = await Promise.all(["series_liquid", "series_pending_total", "series_principal", "series_total_shares"]
      .map(async (functionName) => {
        const result = await relayer.readAsync({
          kind: "contract-invoke",
          payload: { args: ["--series", String(series)], contractId: vaultId, functionName, send: "no" },
        });
        const raw = result.output.trim();
        const parsed = raw.startsWith('"') ? String(JSON.parse(raw)) : raw;
        if (!/^[0-9]+$/.test(parsed)) throw new Error(`invalid ${functionName} response`);
        return BigInt(parsed);
      }));
    return { liquid: values[0]!, pending: values[1]!, principal: values[2]!, shares: values[3]! };
  }
}

function optionalArg(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--") || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${flag} requires a nonnegative integer`);
  }
  return value;
}

function requiredArg(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
