import { MongoClient } from "@/shared/mongo/client";
import type { Hex } from "@pnlx/protocol-types";
import { loadEnv } from "@/config/env";
import { markMakerCloseOutputSettled, readMakerNotes } from "@/shared/maker-note-store";
import {
  closeVaultMakerAllocation,
  readVaultMakerAllocations,
  remainingVaultMakerPrincipal,
  type VaultMakerAllocation,
} from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { assertSuccessfulTransaction } from "./register-vault-maker-note";

interface PositionSettlement {
  _id: string;
  allocationId: string;
  allocationPrincipalBefore: string;
  closeTxHash: string;
  makerBalanceBefore: string;
  namespace: string;
  noteCommitment: Hex;
  positionCommitment: Hex;
  principal: string;
  returned: string;
  seriesLiquidBefore: string;
  seriesPrincipalBefore: string;
  status: "pending" | "submitted" | "confirmed";
  txHash?: string;
}

export async function settleVaultMakerPosition(input: {
  allocationId: string;
  closeTxHash: string;
  noteCommitment: Hex;
  operatorSource: string;
  positionCommitment: Hex;
  principal: bigint;
}): Promise<void> {
  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || env.stellarRelayerMode !== "stellar-cli" ||
    !env.stellarOnchainRelay || !env.mongodbUri || !env.collateralTokenContract || !env.makerWalletAddress) {
    throw new Error("Testnet vault maker configuration is required");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  const vaultId = deployment?.contracts["liquidity-vault"];
  if (!vaultId || input.principal <= 0n) throw new Error("vault and positive maker principal are required");
  const allocationsBefore = await readVaultMakerAllocations();
  const allocation = allocationsBefore.find((item) => item.id === input.allocationId);
  if (!allocation || allocation.vault !== vaultId ||
    allocation.maker !== env.makerWalletAddress.trim().toUpperCase() ||
    allocation.asset !== env.collateralTokenContract) {
    throw new Error("outstanding maker allocation does not match the vault");
  }
  const note = (await readMakerNotes()).find((item) => item.commitment === input.noteCommitment &&
    item.vaultAllocationId === input.allocationId && item.closePositionCommitment === input.positionCommitment);
  if (!note || note.status !== "spent" || !note.recoveredAmount ||
    note.closeTxHash !== input.closeTxHash || note.walletAddress !== allocation.maker ||
    BigInt(String(note.recoveredAmount)) <= 0n) {
    throw new Error("confirmed maker close output must be recovered before vault settlement");
  }
  const returned = BigInt(String(note.recoveredAmount));
  await assertSuccessfulTransaction(env.stellarRpcUrl, input.closeTxHash);

  const relayer = createRelayer({ config: {
    commandTimeoutMs: env.stellarCommandTimeoutMs,
    mode: "stellar-cli", network: env.stellarNetwork,
    networkPassphrase: env.stellarNetworkPassphrase,
    rpcUrl: env.stellarRpcUrl, source: input.operatorSource,
  } });
  const readAmount = async (contractId: string, method: string, args: string[]): Promise<bigint> => {
    const result = await relayer.readAsync({ kind: "contract-invoke", payload: {
      args, contractId, functionName: method, send: "no",
    } });
    const raw = result.output.trim();
    const value = raw.startsWith('"') ? String(JSON.parse(raw)) : raw;
    if (!/^[0-9]+$/.test(value)) throw new Error(`invalid ${method} amount`);
    return BigInt(value);
  };
  const seriesArgs = ["--series", String(allocation.series)];
  const balances = async () => ({
    principal: await readAmount(vaultId, "series_principal", seriesArgs),
    liquid: await readAmount(vaultId, "series_liquid", seriesArgs),
    maker: await readAmount(allocation.asset, "balance", ["--id", allocation.maker]),
  });
  const client = new MongoClient(env.mongodbUri);
  await client.connect();
  try {
    const db = client.db(env.mongodbDatabase);
    const namespace = env.stellarNetwork;
    const receipts = db.collection<PositionSettlement>("vault_maker_position_settlements");
    const id = `${namespace}:${input.positionCommitment}`;
    let receipt = await receipts.findOne({ _id: id });
    let createdNow = false;
    if (!receipt) {
      if (allocation.status !== "outstanding" || input.principal > remainingVaultMakerPrincipal(allocation)) {
        throw new Error("maker position principal exceeds outstanding allocation");
      }
      const before = await balances();
      const recordedPrincipal = allocationsBefore
        .filter((item) => item.vault === vaultId && item.series === allocation.series && item.status !== "closed")
        .reduce((sum, item) => sum + remainingVaultMakerPrincipal(item), 0n);
      if (before.principal !== recordedPrincipal) {
        throw new Error("on-chain vault principal differs from recorded maker allocations");
      }
      if (before.principal < input.principal || before.maker < returned) {
        throw new Error("vault principal or maker balance is insufficient for position settlement");
      }
      const proposed: PositionSettlement = {
        _id: id, namespace, allocationId: allocation.id,
        allocationPrincipalBefore: remainingVaultMakerPrincipal(allocation).toString(),
        closeTxHash: input.closeTxHash, makerBalanceBefore: before.maker.toString(),
        noteCommitment: input.noteCommitment, positionCommitment: input.positionCommitment,
        principal: input.principal.toString(), returned: returned.toString(),
        seriesLiquidBefore: before.liquid.toString(),
        seriesPrincipalBefore: before.principal.toString(), status: "pending",
      };
      try {
        await receipts.insertOne(proposed);
        receipt = proposed;
        createdNow = true;
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        receipt = await receipts.findOne({ _id: id });
      }
    }
    if (!receipt || receipt.allocationId !== allocation.id ||
      receipt.closeTxHash !== input.closeTxHash || receipt.noteCommitment !== input.noteCommitment ||
      receipt.principal !== input.principal.toString() || receipt.returned !== returned.toString()) {
      throw new Error("maker position settlement receipt conflicts with recovered output");
    }
    if (receipt.status === "confirmed") {
      await markMakerCloseOutputSettled(input.noteCommitment, receipt.txHash!);
      return;
    }
    if (receipt.status === "pending") {
      // An earlier process may have submitted the transfer before it could save a hash.
      if (!createdNow || receipt.txHash) {
        throw new Error("pending maker settlement has unknown submission outcome; manual reconciliation required");
      }
      const current = await balances();
      if (current.principal !== BigInt(receipt.seriesPrincipalBefore) ||
        current.liquid !== BigInt(receipt.seriesLiquidBefore) ||
        current.maker !== BigInt(receipt.makerBalanceBefore)) {
        throw new Error("pending maker settlement has unknown on-chain outcome; manual reconciliation required");
      }
      const tx = await relayer.relayAsync({ kind: "contract-invoke", payload: {
        args: ["--series", String(allocation.series), "--principal", receipt.principal,
          "--returned", receipt.returned],
        contractId: vaultId, functionName: "settle", send: "yes", source: input.operatorSource,
      } });
      if (!tx.submitted || !tx.txHash) {
        throw new Error("maker position vault settlement was not submitted");
      }
      await receipts.updateOne({ _id: id, status: "pending", txHash: { $exists: false } },
        { $set: { status: "submitted", txHash: tx.txHash } });
      receipt = { ...receipt, status: "submitted", txHash: tx.txHash };
    }
    if (!receipt.txHash) throw new Error("maker settlement transaction hash is missing");
    await assertSuccessfulTransaction(env.stellarRpcUrl, receipt.txHash);
    const after = await balances();
    if (after.principal !== BigInt(receipt.seriesPrincipalBefore) - input.principal ||
      after.liquid !== BigInt(receipt.seriesLiquidBefore) + returned ||
      after.maker !== BigInt(receipt.makerBalanceBefore) - returned) {
      throw new Error("maker position vault settlement balances do not reconcile");
    }
    await applyPrincipalReceipt(db, namespace, allocation, input.principal,
      BigInt(receipt.allocationPrincipalBefore));
    await markMakerCloseOutputSettled(input.noteCommitment, receipt.txHash);
    if (BigInt(receipt.allocationPrincipalBefore) === input.principal) {
      const current = await db.collection<VaultMakerAllocation & { _id: string }>("vault_maker_allocations")
        .findOne({ _id: `${namespace}:${allocation.id}` });
      if (current?.status === "outstanding") await closeVaultMakerAllocation(allocation.id);
      else if (current?.status !== "closed") throw new Error("maker allocation did not close after final receipt");
    }
    await receipts.updateOne({ _id: id, status: "submitted", txHash: receipt.txHash },
      { $set: { status: "confirmed" } });
    process.stdout.write(`${JSON.stringify({ positionCommitment: input.positionCommitment,
      principal: receipt.principal, returned: receipt.returned, txHash: receipt.txHash, status: "confirmed" })}\n`);
  } finally {
    await client.close();
  }
}

async function applyPrincipalReceipt(
  db: ReturnType<MongoClient["db"]>,
  namespace: string,
  allocation: VaultMakerAllocation,
  principal: bigint,
  before: bigint,
): Promise<void> {
  const allocations = db.collection<VaultMakerAllocation & { _id: string }>("vault_maker_allocations");
  const after = before - principal;
  const current = await allocations.findOne({ _id: `${namespace}:${allocation.id}` });
  if (!current) throw new Error("maker allocation disappeared before principal reconciliation");
  const actual = remainingVaultMakerPrincipal(current);
  if (actual === after) return;
  if (actual !== before || current.status !== "outstanding") {
    throw new Error("maker allocation principal changed during position reconciliation");
  }
  const result = await allocations.updateOne(
    { _id: current._id, status: "outstanding",
      ...(current.remainingPrincipal === undefined
        ? { remainingPrincipal: { $exists: false } }
        : { remainingPrincipal: current.remainingPrincipal }) },
    { $set: { remainingPrincipal: after.toString() } },
  );
  if (result.modifiedCount !== 1) throw new Error("maker allocation principal changed before receipt was applied");
}
