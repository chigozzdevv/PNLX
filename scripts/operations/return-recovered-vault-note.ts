import { ownerCommitment } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import { loadEnv } from "@/config/env";
import { reconstructPositionOpening } from "@/features/account-keys/account-key-recovery";
import { MongoClient } from "@/shared/mongo/client";
import { markRecoveredMakerNoteSettled, readMakerNotes, type StoredMakerNoteRecord } from "@/shared/maker-note-store";
import { withVaultMakerLease } from "@/shared/vault-maker-lease";
import { allocationId, readVaultMakerAllocations, recordedSeriesPrincipal,
  remainingVaultMakerPrincipal, type VaultMakerAllocation } from "@/shared/vault-maker-backing";
import { createExecutorAsync } from "@/workers/executor/executor.worker";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createRelayer } from "@/workers/relayer/relayer.worker";
import { assertSuccessfulTransaction } from "./register-vault-maker-note";

interface ReturnReceipt {
  _id: string;
  allocationId: string;
  allocationPrincipalBefore: string;
  makerBalanceBefore: string;
  noteCommitment: string;
  principal: string;
  seriesLiquidBefore: string;
  seriesPrincipalBefore: string;
  status: "pending" | "submitted" | "confirmed";
  txHash?: string;
}

if (import.meta.main) await returnRecoveredVaultNote(process.argv.slice(2));

export async function returnRecoveredVaultNote(argv: string[]): Promise<void> {
  const execute = argv.includes("--execute");
  if (execute && !argv.includes("--matcher-stopped")) {
    throw new Error("stop matching before returning recovered maker principal");
  }
  const allocationTx = requiredArg(argv, "--allocation-tx");
  const commitment = requiredArg(argv, "--note-commitment");
  if (!/^0x[0-9a-fA-F]{64}$/.test(commitment)) throw new Error("invalid note commitment");
  const operatorSource = requiredArg(argv, "--operator-source");
  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || env.stellarRelayerMode !== "stellar-cli" ||
    !env.stellarOnchainRelay || !env.mongodbUri || !env.collateralTokenContract || !env.makerWalletAddress) {
    throw new Error("Testnet vault maker configuration is required");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  const vault = deployment?.contracts["liquidity-vault"];
  const pool = deployment?.contracts["shielded-pool"];
  if (!vault || !pool) throw new Error("vault and pool deployments are required");
  const id = allocationId(vault, allocationTx);
  await withVaultMakerLease(env.mongodbUri, env.mongodbDatabase, `${env.stellarNetwork}:${vault}`,
    async (assertLease) => {
      const allocations = await readVaultMakerAllocations();
      const allocation = allocations.find((item) => item.id === id);
      if (!allocation || allocation.status !== "outstanding" ||
        allocation.asset !== env.collateralTokenContract ||
        allocation.maker !== env.makerWalletAddress!.trim().toUpperCase()) {
        throw new Error("outstanding maker allocation does not match the vault");
      }
      const notes = (await readMakerNotes()).filter((item) => item.vaultAllocationId === id);
      const note = notes.find((item) => item.commitment === commitment);
      const receiptId = `${env.stellarNetwork}:${commitment}`;
      const receiptClient = new MongoClient(env.mongodbUri!);
      await receiptClient.connect();
      const priorReceipt = await receiptClient.db(env.mongodbDatabase)
        .collection<ReturnReceipt>("vault_maker_note_returns").findOne({ _id: receiptId });
      await receiptClient.close();
      if (!note || note.status !== "spent" || note.walletAddress !== allocation.maker ||
        (note.vaultSettlementTxHash && note.vaultSettlementTxHash !== priorReceipt?.txHash) ||
        note.recoveredAmount !== note.amount ||
        typeof note.noteNullifier !== "string") {
        throw new Error("selected maker note has not been fully recovered for this settlement");
      }
      const returned = BigInt(String(note.amount));
      const outstanding = remainingVaultMakerPrincipal(allocation);
      if (returned <= 0n || (!priorReceipt && returned > outstanding)) {
        throw new Error("recovered amount exceeds deployed principal");
      }
      assertLinearRecoveredChain(allocation, notes, commitment);

      if (!priorReceipt) {
        const executor = await createExecutorAsync({ mongo: {
          collection: env.mongodbCollection, database: env.mongodbDatabase,
          documentId: env.stellarNetwork, ensureIndexes: false, uri: env.mongodbUri!,
        }, privateMatchingRequired: env.privateMatchingRequired });
        try {
          const intents = new Set(notes.map((item) => String(item.lockedByIntentCommitment ?? "")).filter(Boolean));
          const linked = executor.store.positionsFor(ownerCommitment(allocation.maker))
            .filter((position) => intents.has(position.sourceIntentCommitment));
          if (linked.some((position) => position.status === "closed" &&
            notes.some((item) => item.lockedByIntentCommitment === position.sourceIntentCommitment &&
              !item.vaultSettlementTxHash))) {
            throw new Error("a linked maker position still needs vault reconciliation");
          }
          const openPrincipal = linked.filter((position) => position.status === "open")
            .reduce((sum, position) => {
              const opening = reconstructPositionOpening(executor.store, position);
              if (!opening) throw new Error("maker position opening is unavailable");
              return sum + opening.margin + (opening.entryFee ?? 0n);
            }, 0n);
          if (outstanding - returned !== openPrincipal) {
            throw new Error("recovered note does not reconcile with open maker position principal");
          }
        } finally {
          await (executor.store as { close?: () => Promise<void> }).close?.();
        }
      }

      const relayer = createRelayer({ config: {
        commandTimeoutMs: env.stellarCommandTimeoutMs, mode: "stellar-cli",
        network: env.stellarNetwork, networkPassphrase: env.stellarNetworkPassphrase,
        rpcUrl: env.stellarRpcUrl, source: operatorSource,
      } });
      const readAmount = async (contractId: string, functionName: string, args: string[]): Promise<bigint> => {
        const result = await relayer.readAsync({ kind: "contract-invoke", payload: {
          args, contractId, functionName, send: "no",
        } });
        const raw = result.output.trim();
        const value = raw.startsWith('"') ? String(JSON.parse(raw)) : raw;
        if (!/^[0-9]+$/.test(value)) throw new Error(`invalid ${functionName} amount`);
        return BigInt(value);
      };
      const balances = async () => ({
        principal: await readAmount(vault, "series_principal", ["--series", String(allocation.series)]),
        liquid: await readAmount(vault, "series_liquid", ["--series", String(allocation.series)]),
        maker: await readAmount(allocation.asset, "balance", ["--id", allocation.maker]),
      });
      const spent = await relayer.readAsync({ kind: "contract-invoke", payload: {
        args: ["--nullifier", String(note.noteNullifier).replace(/^0x/, "")],
        contractId: pool, functionName: "is_spent", send: "no",
      } });
      if (spent.output.trim() !== "true") throw new Error("recovered maker note is not spent on-chain");
      const before = await balances();
      if (!priorReceipt && (before.principal !== recordedSeriesPrincipal(allocations, vault, allocation.series) ||
        before.maker < returned)) {
        throw new Error("vault principal or maker balance does not reconcile");
      }
      process.stdout.write(`${JSON.stringify({ allocationId: id, noteCommitment: commitment,
        principal: returned.toString(), status: priorReceipt?.status ?? (execute ? "ready" : "dry-run") })}\n`);
      if (!execute) return;

      const client = new MongoClient(env.mongodbUri!);
      await client.connect();
      try {
        const database = client.db(env.mongodbDatabase);
        const receipts = database.collection<ReturnReceipt>("vault_maker_note_returns");
        let receipt = await receipts.findOne({ _id: receiptId });
        let createdNow = false;
        if (!receipt) {
          const proposed: ReturnReceipt = {
            _id: receiptId, allocationId: id, allocationPrincipalBefore: outstanding.toString(),
            makerBalanceBefore: before.maker.toString(), noteCommitment: commitment,
            principal: returned.toString(), seriesLiquidBefore: before.liquid.toString(),
            seriesPrincipalBefore: before.principal.toString(), status: "pending",
          };
          try {
            await receipts.insertOne(proposed);
            receipt = proposed;
            createdNow = true;
          } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
            receipt = await receipts.findOne({ _id: receiptId });
          }
        }
        if (!receipt || receipt.allocationId !== id || receipt.noteCommitment !== commitment ||
          receipt.principal !== returned.toString()) throw new Error("maker return receipt conflicts with the note");
        if (receipt.status === "pending") {
          if (!createdNow) throw new Error("pending maker return has unknown submission outcome; reconcile it before retrying");
          assertLease();
          const tx = await relayer.relayAsync({ kind: "contract-invoke", payload: {
            args: ["--series", String(allocation.series), "--principal", receipt.principal,
              "--returned", receipt.principal],
            contractId: vault, functionName: "settle", send: "yes", source: operatorSource,
          } });
          if (!tx.submitted || !tx.txHash) throw new Error("maker return was not submitted");
          await receipts.updateOne({ _id: receiptId, status: "pending", txHash: { $exists: false } },
            { $set: { status: "submitted", txHash: tx.txHash } });
          receipt = { ...receipt, status: "submitted", txHash: tx.txHash };
        }
        if (!receipt.txHash) throw new Error("maker return transaction hash is missing");
        await assertSuccessfulTransaction(env.stellarRpcUrl, receipt.txHash);
        const after = await balances();
        if (after.principal !== BigInt(receipt.seriesPrincipalBefore) - returned ||
          after.liquid !== BigInt(receipt.seriesLiquidBefore) + returned ||
          after.maker !== BigInt(receipt.makerBalanceBefore) - returned) {
          throw new Error("maker return balances do not reconcile");
        }
        await applyReturnReceipt(database, env.stellarNetwork, allocation, receipt);
        await markRecoveredMakerNoteSettled(commitment, receipt.txHash);
        await receipts.updateOne({ _id: receiptId, status: "submitted", txHash: receipt.txHash },
          { $set: { status: "confirmed" } });
        process.stdout.write(`${JSON.stringify({ allocationId: id, principal: receipt.principal,
          txHash: receipt.txHash, status: "confirmed" })}\n`);
      } finally {
        await client.close();
      }
    });
}

export function assertLinearRecoveredChain(
  allocation: VaultMakerAllocation,
  notes: StoredMakerNoteRecord[],
  terminalCommitment: string,
): void {
  const byCommitment = new Map(notes.map((note) => [String(note.commitment), note]));
  if (byCommitment.size !== notes.length || notes.length === 0 ||
    allocation.noteCommitments.length !== 1) throw new Error("maker note chain is ambiguous");
  const root = allocation.noteCommitments[0];
  const descendants = new Map<string, string[]>();
  for (const note of notes) {
    if (note.status !== "spent") throw new Error("maker allocation still has an unspent note");
    const parent = note.vaultParentCommitment;
    if (typeof parent !== "string") continue;
    const children = descendants.get(parent) ?? [];
    children.push(String(note.commitment));
    descendants.set(parent, children);
  }
  if (!root || !byCommitment.has(root) || descendants.has(terminalCommitment)) {
    throw new Error("recovered note is not the terminal allocation note");
  }
  const seen = new Set<string>();
  let cursor = root;
  while (true) {
    if (seen.has(cursor)) throw new Error("maker note ancestry contains a cycle");
    seen.add(cursor);
    const children = descendants.get(cursor) ?? [];
    if (children.length === 0) break;
    if (children.length !== 1 || !byCommitment.has(children[0])) {
      throw new Error("maker note chain has an unknown or branching child");
    }
    if (BigInt(String(byCommitment.get(children[0])!.amount)) >=
      BigInt(String(byCommitment.get(cursor)!.amount))) {
      throw new Error("maker note child does not reduce the allocation balance");
    }
    cursor = children[0];
  }
  if (cursor !== terminalCommitment || seen.size !== notes.length) {
    throw new Error("recovered note does not cover the complete allocation chain");
  }
}

async function applyReturnReceipt(
  database: ReturnType<MongoClient["db"]>, namespace: string,
  allocation: VaultMakerAllocation, receipt: ReturnReceipt,
): Promise<void> {
  const allocations = database.collection<VaultMakerAllocation & { _id: string }>("vault_maker_allocations");
  const before = BigInt(receipt.allocationPrincipalBefore);
  const after = before - BigInt(receipt.principal);
  const current = await allocations.findOne({ _id: `${namespace}:${allocation.id}` });
  if (!current) throw new Error("maker allocation disappeared before return reconciliation");
  if (remainingVaultMakerPrincipal(current) === after) return;
  if (remainingVaultMakerPrincipal(current) !== before || current.status !== "outstanding") {
    throw new Error("maker allocation principal changed before return reconciliation");
  }
  const result = await allocations.updateOne(
    { _id: current._id, status: "outstanding",
      ...(current.remainingPrincipal === undefined
        ? { remainingPrincipal: { $exists: false } }
        : { remainingPrincipal: current.remainingPrincipal }) },
    { $set: { remainingPrincipal: after.toString() } },
  );
  if (result.modifiedCount !== 1) throw new Error("maker allocation changed before receipt was applied");
}

function requiredArg(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
