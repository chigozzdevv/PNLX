import { loadEnv } from "@/config/env";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import { readMakerNotes } from "@/shared/maker-note-store";
import { allocationId, closeVaultMakerAllocation, normalizedHash, readVaultMakerAllocations } from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { assertSuccessfulTransaction } from "./register-vault-maker-note";

if (import.meta.main) await settleVaultMaker(process.argv.slice(2));

export async function settleVaultMaker(argv: string[]): Promise<void> {
  if (!argv.includes("--matcher-stopped")) {
    throw new Error("stop the matcher before settling a vault maker allocation");
  }
  const allocationTx = normalizedHash(requiredArg(argv, "--allocation-tx"));
  const returnedText = requiredArg(argv, "--returned");
  const operatorSource = requiredArg(argv, "--operator-source");
  if (!/^(0|[1-9][0-9]*)$/.test(returnedText)) throw new Error("returned must be nonnegative base units");
  const returned = BigInt(returnedText);
  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || env.stellarRelayerMode !== "stellar-cli" ||
    !env.stellarOnchainRelay || !env.makerWalletAddress || !env.collateralTokenContract) {
    throw new Error("Testnet vault maker and Stellar relay are required");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  const vaultId = deployment?.contracts["liquidity-vault"];
  if (!vaultId) throw new Error("liquidity vault deployment is required");
  const id = allocationId(vaultId, allocationTx);
  const allocation = (await readVaultMakerAllocations()).find((item) => item.id === id);
  if (!allocation || allocation.status !== "outstanding" || !Number.isSafeInteger(allocation.series) ||
    allocation.series < 0 || allocation.asset !== env.collateralTokenContract ||
    allocation.maker !== env.makerWalletAddress.trim().toUpperCase()) {
    throw new Error("outstanding vault allocation does not match this maker and asset");
  }
  const notes = (await readMakerNotes()).filter((note) => note.vaultAllocationId === id);
  if (notes.some((note) => ["available", "locked", "withdrawing"].includes(String(note.status)))) {
    throw new Error("maker notes must be recovered before vault settlement");
  }
  const principal = BigInt(allocation.amount);
  const relayer = createRelayer({ config: {
    commandTimeoutMs: env.stellarCommandTimeoutMs,
    mode: "stellar-cli",
    network: env.stellarNetwork,
    networkPassphrase: env.stellarNetworkPassphrase,
    rpcUrl: env.stellarRpcUrl,
    source: operatorSource,
  } });
  const vault = new LiquidityVaultService(relayer, deployment);
  const before = await vault.status();
  if (before.asset !== allocation.asset || before.maker !== allocation.maker ||
    await seriesPrincipal() !== principal) {
    throw new Error("vault series principal does not equal the recorded allocation");
  }
  const makerBefore = await makerBalance();
  const method = returned === 0n ? "record_loss" : "settle";
  const tx = await relayer.relayAsync({
    kind: "contract-invoke",
    payload: {
      args: ["--series", String(allocation.series), "--principal", allocation.amount,
        ...(returned === 0n ? [] : ["--returned", returnedText])],
      contractId: vaultId,
      functionName: method,
      send: "yes",
      source: operatorSource,
    },
  });
  if (!tx.submitted || !tx.txHash) throw new Error("vault settlement was not submitted");
  process.stdout.write(`${JSON.stringify({ allocationId: id, series: allocation.series, txHash: tx.txHash, status: "submitted" })}\n`);
  await assertSuccessfulTransaction(env.stellarRpcUrl, tx.txHash);
  const after = await vault.status();
  const makerAfter = await makerBalance();
  if (await seriesPrincipal() !== 0n ||
    BigInt(before.deployedPrincipal) - BigInt(after.deployedPrincipal) !== principal ||
    BigInt(after.liquidAssets) - BigInt(before.liquidAssets) !== returned ||
    makerBefore - makerAfter !== returned) {
    throw new Error(`settlement ${tx.txHash} succeeded but vault and maker balances did not reconcile`);
  }
  await closeVaultMakerAllocation(id);
  process.stdout.write(`${JSON.stringify({ allocationId: id, principal: allocation.amount,
    returned: returnedText, series: allocation.series, txHash: tx.txHash, status: "closed" })}\n`);

  async function seriesPrincipal(): Promise<bigint> {
    const result = await relayer.readAsync({
      kind: "contract-invoke",
      payload: { args: ["--series", String(allocation!.series)], contractId: vaultId,
        functionName: "series_principal", send: "no" },
    });
    return parseAmount(result.output);
  }

  async function makerBalance(): Promise<bigint> {
    const result = await relayer.readAsync({
      kind: "contract-invoke",
      payload: { args: ["--id", allocation!.maker], contractId: allocation!.asset,
        functionName: "balance", send: "no" },
    });
    return parseAmount(result.output);
  }
}

function parseAmount(output: string): bigint {
  const raw = output.trim();
  const value = raw.startsWith('"') ? String(JSON.parse(raw)) : raw;
  if (!/^[0-9]+$/.test(value)) throw new Error("invalid contract amount response");
  return BigInt(value);
}

function requiredArg(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
