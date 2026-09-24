import { spawnSync } from "node:child_process";
import { ownerCommitment } from "@pnlx/crypto";
import { loadEnv } from "@/config/env";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import { readMakerNotes } from "@/shared/maker-note-store";
import { withVaultMakerLease } from "@/shared/vault-maker-lease";
import { beginVaultMakerDrain, eligibleVaultMakerNotes, readVaultMakerAllocations } from "@/shared/vault-maker-backing";
import { createExecutorAsync } from "@/workers/executor/executor.worker";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { localApiOrigin, runCustodySmoke } from "../smoke/custody";
import { allocate } from "./allocate-vault-maker";
import { register } from "./register-vault-maker-note";
import { settleVaultMaker } from "./settle-vault-maker";
import { withdrawMakerNotes } from "./withdraw-maker-notes";

const STROOP = 10_000_000n;
const POLL_MS = 20_000;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const readyAmount = positiveAmount(requiredArg(args, "--ready-usdc")) * STROOP;
  const operatorSource = requiredArg(args, "--operator-source");
  const makerSource = requiredArg(args, "--maker-source");
  const apiUrl = localApiOrigin(requiredArg(args, "--api-url"));
  do {
    try {
      await provisionOnce({ apiUrl, makerSource, operatorSource, readyAmount });
    } catch (error) {
      console.error(`[vault-maker] ${error instanceof Error ? error.message : String(error)}`);
      if (args.includes("--once")) throw error;
    }
    if (args.includes("--once")) break;
    await Bun.sleep(POLL_MS);
  } while (true);
}

export function makerTopUpAmount(input: {
  currentSeriesAssets: bigint;
  currentSeriesLiquid: bigint;
  currentSeriesPrincipal: bigint;
  deployedPrincipal: bigint;
  limitBps: bigint;
  readyAmount: bigint;
  targetAmount: bigint;
  totalAssets: bigint;
}): bigint {
  if (input.targetAmount <= input.readyAmount) return 0n;
  const globalCapacity = input.totalAssets * input.limitBps / 10_000n - input.deployedPrincipal;
  const seriesCapacity = input.currentSeriesAssets * input.limitBps / 10_000n - input.currentSeriesPrincipal;
  return [input.targetAmount - input.readyAmount, globalCapacity, seriesCapacity, input.currentSeriesLiquid]
    .reduce((smallest, amount) => amount < smallest ? amount : smallest);
}

export async function provisionOnce(input: {
  apiUrl: string;
  makerSource: string;
  operatorSource: string;
  readyAmount: bigint;
}): Promise<void> {
  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || env.stellarRelayerMode !== "stellar-cli" ||
    !env.stellarOnchainRelay || !env.collateralTokenContract || !env.makerWalletAddress || !env.mongodbUri) {
    throw new Error("Testnet vault, maker, and MongoDB configuration are required");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  const vaultId = deployment?.contracts["liquidity-vault"];
  if (!vaultId || !deployment?.contracts["shielded-pool"]) throw new Error("vault and pool deployments are required");
  const relayer = createRelayer({ config: {
    commandTimeoutMs: env.stellarCommandTimeoutMs,
    mode: "stellar-cli",
    network: env.stellarNetwork,
    networkPassphrase: env.stellarNetworkPassphrase,
    rpcUrl: env.stellarRpcUrl,
    source: input.operatorSource,
  } });
  const status = await new LiquidityVaultService(relayer, deployment).status();
  if (status.contractId !== vaultId || status.asset !== env.collateralTokenContract ||
    status.maker !== env.makerWalletAddress.trim().toUpperCase()) {
    throw new Error("configured vault, asset, and maker do not agree");
  }
  if (sourceAddress(input.operatorSource) !== status.operator ||
    sourceAddress(input.makerSource) !== status.maker) {
    throw new Error("operator or maker CLI source does not control the vault account");
  }

  await withVaultMakerLease(env.mongodbUri, env.mongodbDatabase, `${env.stellarNetwork}:${vaultId}`, async (assertLease) => {
    for (let series = 0; series <= status.currentSeries; series += 1) {
      if (await readAmount("series_pending_total", series) === 0n) continue;
      const pendingAllocations = (await readVaultMakerAllocations())
        .filter((item) => item.vault === vaultId && item.series === series && item.status !== "closed");
      for (const allocation of pendingAllocations) {
        assertLease();
        await beginVaultMakerDrain(allocation.id);
        try {
          await withdrawMakerNotes(["--allocation-tx", allocation.allocationTxHash,
            "--execute", "--allocation-draining", "--api-url", input.apiUrl,
            "--maker-source", input.makerSource]);
          const allocationNotes = (await readMakerNotes())
            .filter((note) => note.vaultAllocationId === allocation.id);
          if (allocationNotes.some((note) => note.status !== "spent")) continue;
          const returned = allocationNotes.reduce((sum, note) =>
            sum + BigInt(String(note.recoveredAmount ?? "0")), 0n);
          assertLease();
          await settleVaultMaker(["--allocation-tx", allocation.allocationTxHash,
            "--returned", String(returned), "--operator-source", input.operatorSource,
            "--allocation-draining"]);
        } catch (error) {
          console.error(`[vault-maker] series ${series} recovery pending: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const current = await new LiquidityVaultService(relayer, deployment).status();
    const allocations = await readVaultMakerAllocations();
    const active = allocations.filter((item) => item.vault === vaultId && item.status !== "closed");
    const notes = await readMakerNotes();
    if (notes.some((note) => note.status === "pending" &&
      active.some((allocation) => allocation.id === note.vaultAllocationId))) {
      throw new Error("an allocated maker note deposit is pending reconciliation");
    }
    if (active.some((allocation) => BigInt(allocation.registeredAmount) !== BigInt(allocation.amount))) {
      throw new Error("an earlier vault allocation has not been fully registered");
    }
    const seriesIds = [...new Set([...active.map((item) => item.series), current.currentSeries])];
    const seriesPrincipals = new Map(await Promise.all(seriesIds.map(async (series) =>
      [series, await readAmount("series_principal", series)] as const)));
    for (const series of seriesIds) {
      const recorded = active.filter((item) => item.series === series)
        .reduce((sum, item) => sum + BigInt(item.amount), 0n);
      if (recorded !== seriesPrincipals.get(series)) {
        throw new Error(`series ${series} principal differs from recorded vault allocations`);
      }
    }
    const backed = eligibleVaultMakerNotes(notes as Array<typeof notes[number] & {
      commitment: string; status: string; walletAddress: string;
    }>, allocations, {
      asset: current.asset,
      deployedPrincipal: BigInt(current.deployedPrincipal),
      maker: current.maker,
      seriesPrincipals,
      vault: vaultId,
    });
    const ready = backed.reduce((sum, note) => sum + BigInt(String(note.amount)), 0n);
    const openDemand = await largestOpenClientMargin(current.maker);
    const target = openDemand > input.readyAmount ? openDemand : input.readyAmount;
    if (ready >= target) return;
    if (active.some((item) => item.series === current.currentSeries && item.status === "draining")) return;
    const pending = await readAmount("series_pending_total", current.currentSeries);
    if (pending !== 0n) return;
    const amount = makerTopUpAmount({
      currentSeriesAssets: BigInt(current.currentSeriesAssets),
      currentSeriesLiquid: BigInt(current.currentSeriesLiquid),
      currentSeriesPrincipal: BigInt(current.currentSeriesPrincipal),
      deployedPrincipal: BigInt(current.deployedPrincipal),
      limitBps: BigInt(current.allocationLimitBps),
      readyAmount: ready,
      targetAmount: target,
      totalAssets: BigInt(current.totalAssetsAtCost),
    });
    if (amount <= 0n) return;

    const apiHealth = await fetch(`${input.apiUrl}/health`);
    if (!apiHealth.ok) throw new Error(`live API is unavailable: ${apiHealth.status}`);
    const apiVaultResponse = await fetch(`${input.apiUrl}/liquidity-vault`);
    if (!apiVaultResponse.ok) throw new Error(`live API vault is unavailable: ${apiVaultResponse.status}`);
    const apiVault = (await apiVaultResponse.json()) as { vault?: { contractId?: string; asset?: string; maker?: string } };
    if (apiVault.vault?.contractId !== vaultId || apiVault.vault.asset !== current.asset ||
      apiVault.vault.maker !== current.maker) {
      throw new Error("live API vault does not match the maker manager deployment");
    }
    assertLease();
    const allocation = await allocate(["--amount", String(amount), "--series", String(current.currentSeries),
      "--operator-source", input.operatorSource]);
    assertLease();
    const deposit = await runCustodySmoke({
      apiUrl: input.apiUrl,
      amount,
      deployAsset: false,
      from: current.maker,
      prepareOnly: false,
      source: input.makerSource,
      token: current.asset,
      vaultAllocationId: allocation.id,
    });
    const commitment = String(deposit.noteCommitment ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) throw new Error("maker note deposit did not return a commitment");
    assertLease();
    await register(["--allocation-tx", allocation.allocationTxHash, "--commitment", commitment]);
    console.log(JSON.stringify({ allocationTxHash: allocation.allocationTxHash,
      amount: String(amount), commitment, status: "ready" }));
  });

  async function readAmount(functionName: string, series: number): Promise<bigint> {
    const result = await relayer.readAsync({ kind: "contract-invoke", payload: {
      args: ["--series", String(series)], contractId: vaultId, functionName, send: "no",
    } });
    const raw = result.output.trim();
    const parsed = raw.startsWith('"') ? String(JSON.parse(raw)) : raw;
    if (!/^[0-9]+$/.test(parsed)) throw new Error(`invalid ${functionName} response`);
    return BigInt(parsed);
  }

  async function largestOpenClientMargin(maker: string): Promise<bigint> {
    const executor = await createExecutorAsync({ mongo: {
      collection: env.mongodbCollection,
      database: env.mongodbDatabase,
      documentId: env.stellarNetwork,
      ensureIndexes: false,
      uri: env.mongodbUri!,
    }, privateMatchingRequired: env.privateMatchingRequired });
    try {
      let largest = 0n;
      const makerOwner = ownerCommitment(maker);
      for (const intent of executor.store.intents.values()) {
        if (intent.marketId !== "xlm-usd-perp" || intent.ownerCommitment === makerOwner ||
          executor.store.orderLifecycle.get(intent.intentCommitment)?.status !== "open") continue;
        const margin = executor.store.privateMatchIntents.get(intent.intentCommitment)?.margin ?? 0n;
        if (margin > largest) largest = margin;
      }
      return largest;
    } finally {
      await (executor.store as { close?: () => Promise<void> }).close?.();
    }
  }
}

function sourceAddress(alias: string): string {
  const result = spawnSync("stellar", ["keys", "address", alias], { encoding: "utf8" });
  if (result.status !== 0 || !/^G[A-Z2-7]{55}$/.test(result.stdout.trim())) {
    throw new Error(`Stellar CLI source ${alias} is unavailable`);
  }
  return result.stdout.trim();
}

function positiveAmount(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("ready amount must be whole USDC");
  return BigInt(value);
}

function requiredArg(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
