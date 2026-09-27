import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "@/config/env";

interface Registry {
  contracts: Record<string, string>;
  feeDestinations: { treasury: string };
  network: string;
}

if (import.meta.main) fundCreditDrops(process.argv.slice(2));

export function fundCreditDrops(argv: string[]): void {
  const source = required(argv, "--treasury-source");
  const requestedText = required(argv, "--amount");
  if (!/^[1-9][0-9]*$/.test(requestedText)) throw new Error("amount must be positive USDC base units");
  const requested = BigInt(requestedText);
  const execute = argv.includes("--execute");
  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || !env.collateralTokenContract) {
    throw new Error("Testnet USDC is required");
  }
  const registry = JSON.parse(readFileSync(resolve(env.stellarDeploymentFile), "utf8")) as Registry;
  const escrow = registry.contracts["rewards-escrow"];
  const pool = registry.contracts["shielded-pool"];
  if (registry.network !== "testnet" || !escrow || !pool ||
    registry.feeDestinations.treasury !== env.treasuryAddress) {
    throw new Error("reward escrow, fee pool and treasury must match the deployment");
  }
  const treasury = run(["stellar", "keys", "address", source]).trim();
  if (treasury !== registry.feeDestinations.treasury) throw new Error("source is not the configured treasury");

  const paidFees = JSON.parse(read(pool, "fee_paid", ["--token", env.collateralTokenContract])) as { treasury: string };
  const paidTreasury = BigInt(paidFees.treasury);
  const funded = readAmount(escrow, "funded");
  const dropFunded = readAmount(escrow, "drop_funded");
  const cap = paidTreasury / 10n;
  if (requested > creditDropHeadroom(paidTreasury, funded, dropFunded)) {
    throw new Error("Credit Drop funding exceeds paid treasury fees or the 10% cap");
  }
  process.stdout.write(`${JSON.stringify({ paidTreasury: paidTreasury.toString(),
    creditDropCap: cap.toString(), previouslyFunded: dropFunded.toString(),
    toFund: requested.toString(), status: execute ? "executing" : "dry-run" })}\n`);
  if (!execute) return;
  write(escrow, "fund_drop", ["--amount", requested.toString()]);
  if (readAmount(escrow, "drop_funded") !== dropFunded + requested) {
    throw new Error("Credit Drop funding submitted but escrow total did not reconcile");
  }
  process.stdout.write(`${JSON.stringify({ funded: requested.toString(), status: "verified" })}\n`);

  function read(id: string, method: string, args: string[]): string {
    return run(["stellar", "contract", "invoke", "--id", id, "--source", source,
      "--network", "testnet", "--send", "no", "--", method, ...args]).trim();
  }

  function readAmount(id: string, method: string): bigint {
    const raw = read(id, method, []);
    const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
    if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`invalid ${method} response`);
    return BigInt(value);
  }

  function write(id: string, method: string, args: string[]): void {
    run(["stellar", "contract", "invoke", "--id", id, "--source", source,
      "--network", "testnet", "--send", "yes", "--auto-sign", "--", method, ...args]);
  }
}

export function creditDropHeadroom(paidTreasury: bigint, funded: bigint, dropFunded: bigint): bigint {
  if (paidTreasury < 0n || funded < 0n || dropFunded < 0n) throw new Error("invalid treasury accounting");
  const dropBudget = paidTreasury / 10n - dropFunded;
  const totalBudget = paidTreasury - funded - dropFunded;
  return dropBudget > 0n && totalBudget > 0n
    ? (dropBudget < totalBudget ? dropBudget : totalBudget) : 0n;
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
