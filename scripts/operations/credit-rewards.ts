import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ownerCommitment } from "@pnlx/crypto";
import { MongoClient } from "@/shared/mongo/client";
import { loadEnv } from "@/config/env";
import { RewardAccrualService } from "@/features/rewards/rewards.accrual";
import { ReferralRegistry } from "@/features/rewards/rewards.referrals";
import { MongoProtocolStore } from "@/shared/mongo/store";

interface Registry {
  contracts: Record<string, string>;
  feeDestinations: { treasury: string };
  network: string;
}

interface StoredGrant {
  _id: string;
  amount: string;
  contractId: string;
  createdAt: string;
  creditedAt?: string;
  grantId: string;
  kind: number;
  owner: string;
}

if (import.meta.main) await creditRewards(process.argv.slice(2));

export async function creditRewards(argv: string[]): Promise<void> {
  const owner = required(argv, "--owner").toUpperCase();
  const kind = required(argv, "--kind");
  const source = required(argv, "--treasury-source");
  const execute = argv.includes("--execute");
  if (!/^G[A-Z2-7]{55}$/.test(owner) || !["rebate", "referral"].includes(kind)) {
    throw new Error("valid owner and reward kind are required");
  }
  const env = loadEnv({ validateRuntime: false });
  if (env.stellarNetwork !== "testnet" || !env.mongodbUri || !env.collateralTokenContract) {
    throw new Error("Testnet, MongoDB and USDC contract are required");
  }
  const registry = JSON.parse(readFileSync(resolve(env.stellarDeploymentFile), "utf8")) as Registry;
  const escrow = registry.contracts["rewards-escrow"];
  const pool = registry.contracts["shielded-pool"];
  if (registry.network !== "testnet" || !escrow || !pool ||
    registry.feeDestinations.treasury !== env.treasuryAddress) {
    throw new Error("reward escrow, fee pool and treasury must match the deployment");
  }
  const treasury = /^G[A-Z2-7]{55}$/.test(source)
    ? source : run(["stellar", "keys", "address", source]).trim();
  if (treasury !== registry.feeDestinations.treasury) throw new Error("source is not the configured treasury");

  const state = await MongoProtocolStore.connect({ uri: env.mongodbUri,
    database: env.mongodbDatabase, collection: env.mongodbCollection, documentId: env.stellarNetwork });
  let earned: bigint;
  try {
    const ownerId = ownerCommitment(owner);
    const referrals = new ReferralRegistry({ uri: env.mongodbUri, database: env.mongodbDatabase });
    const accrual = new RewardAccrualService(state, env.makerWalletAddress)
      .forOwner(ownerId, await referrals.forReferrer(ownerId));
    if (!accrual.complete) throw new Error("reward accrual is not fully reconciled");
    earned = kind === "rebate" ? accrual.rebate : accrual.referral;
  } finally { await state.close(); }

  const kindId = kind === "rebate" ? 0 : 1;
  const credited = readAmount(escrow, "credited_total", ["--owner", owner, "--kind", String(kindId)]);
  const available = readAmount(escrow, "available", []);
  const funded = readAmount(escrow, "funded", []);
  const dropFunded = readAmount(escrow, "drop_funded", []);
  const paidFees = JSON.parse(read(pool, "fee_paid", ["--token", env.collateralTokenContract])) as { treasury: string };
  const paidTreasury = BigInt(paidFees.treasury);
  if (credited > earned) throw new Error("escrow credits exceed confirmed earned rewards");
  const delta = earned - credited;
  const shortfall = delta > available ? delta - available : 0n;
  if (funded + dropFunded + shortfall > paidTreasury) {
    throw new Error("rewards funding exceeds paid treasury fees");
  }
  const grantId = createHash("sha256").update(`pnlx-reward-v1:${escrow}:${kind}:${owner}:${credited}:${earned}`).digest("hex");
  process.stdout.write(`${JSON.stringify({ owner, kind, earned: earned.toString(), credited: credited.toString(),
    toCredit: delta.toString(), toFund: shortfall.toString(), paidTreasury: paidTreasury.toString(),
    grantId, status: execute ? "executing" : "dry-run" })}\n`);
  if (!execute || delta === 0n) return;
  const mongo = new MongoClient(env.mongodbUri);
  try {
    await mongo.connect();
    await mongo.db(env.mongodbDatabase).collection<StoredGrant>("reward_grants").updateOne(
      { _id: `${escrow}:${grantId}` },
      { $setOnInsert: { contractId: escrow, owner, kind: kindId, grantId,
        amount: delta.toString(), createdAt: new Date().toISOString() } }, { upsert: true },
    );
  } finally { await mongo.close(); }
  if (shortfall > 0n) {
    write(escrow, "fund_and_credit", ["--grant_id", grantId, "--owner", owner,
      "--kind", String(kindId), "--funding_amount", shortfall.toString(),
      "--reward_amount", delta.toString()]);
  } else {
    write(escrow, "credit", ["--grant_id", grantId, "--owner", owner,
      "--kind", String(kindId), "--amount", delta.toString()]);
  }
  if (readAmount(escrow, "credited_total", ["--owner", owner, "--kind", String(kindId)]) !== earned) {
    throw new Error("reward credit submitted but escrow total did not reconcile");
  }
  const confirmed = new MongoClient(env.mongodbUri);
  try {
    await confirmed.connect();
    await confirmed.db(env.mongodbDatabase).collection<StoredGrant>("reward_grants").updateOne(
      { _id: `${escrow}:${grantId}` }, { $set: { creditedAt: new Date().toISOString() } },
    );
  } finally { await confirmed.close(); }
  process.stdout.write(`${JSON.stringify({ owner, kind, amount: delta.toString(), grantId, status: "verified" })}\n`);

  function read(id: string, method: string, args: string[]): string {
    return run(["stellar", "contract", "invoke", "--id", id, "--source", source,
      "--network", "testnet", "--send", "no", "--", method, ...args]).trim();
  }

  function readAmount(id: string, method: string, args: string[]): bigint {
    const raw = read(id, method, args);
    const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
    if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`invalid ${method} response`);
    return BigInt(value);
  }

  function write(id: string, method: string, args: string[]): void {
    run(["stellar", "contract", "invoke", "--id", id, "--source", source,
      "--network", "testnet", "--send", "yes", "--auto-sign", "--", method, ...args]);
  }
}

function required(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? "" : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function run(command: string[]): string {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
