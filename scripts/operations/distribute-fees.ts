import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "@/config/env";

interface FeeAmounts {
  insurance: bigint;
  treasury: bigint;
}

interface FeeDestinations {
  insurance: string;
  treasury: string;
}

if (import.meta.main) distributeFees(process.argv.slice(2));

export function distributeFees(argv: string[]): void {
  const env = loadEnv({ validateRuntime: false });
  const registryPath = arg(argv, "--registry", env.stellarDeploymentFile);
  const source = arg(argv, "--source", env.stellarSource);
  const registry = JSON.parse(readFileSync(resolve(registryPath), "utf8")) as {
    contracts: Record<string, string>;
    network: string;
    feeDestinations?: FeeDestinations;
  };
  if (registry.network !== "testnet") throw new Error("fee distribution is Testnet-only");
  const pool = registry.contracts["shielded-pool"];
  const token = env.collateralTokenContract;
  if (!/^C[A-Z2-7]{55}$/.test(pool ?? "") || !/^C[A-Z2-7]{55}$/.test(token)) {
    throw new Error("fee pool and collateral token must be configured");
  }

  const invoke = (id: string, method: string, args: string[], send: "no" | "yes" = "no"): string => {
    const command = ["stellar", "contract", "invoke", "--id", id, "--source", source,
      "--network", "testnet", "--send", send, "--auto-sign", "--", method, ...args];
    const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 120_000 });
    if (result.status !== 0) throw new Error(`${method} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const parse = (raw: string): unknown => JSON.parse(raw);
  const readAmounts = (method: string): FeeAmounts => {
    const value = parse(invoke(pool, method, ["--token", token])) as Record<string, string>;
    return { insurance: BigInt(value.insurance), treasury: BigInt(value.treasury) };
  };
  const balance = (address: string): bigint => BigInt(String(parse(invoke(token, "balance", ["--id", address]))));
  const destinations = parse(invoke(pool, "fee_destinations", [])) as FeeDestinations | null;
  if (!destinations || destinations.insurance === destinations.treasury ||
      !/^[GC][A-Z2-7]{55}$/.test(destinations.insurance) ||
      !/^[GC][A-Z2-7]{55}$/.test(destinations.treasury) ||
      (registry.feeDestinations && (destinations.insurance !== registry.feeDestinations.insurance ||
        destinations.treasury !== registry.feeDestinations.treasury))) {
    throw new Error("on-chain fee destinations do not match the deployment");
  }

  let distributed = false;
  for (const kind of ["insurance", "treasury"] as const) {
    const reserveBefore = readAmounts("fee_reserve");
    if (reserveBefore[kind] === 0n) continue;
    distributed = true;
    const paidBefore = readAmounts("fee_paid");
    const recipientBefore = balance(destinations[kind]);
    const poolBefore = balance(pool);
    invoke(pool, `distribute_${kind}`, ["--token", token], "yes");
    const reserveAfter = readAmounts("fee_reserve");
    const paidAfter = readAmounts("fee_paid");
    const recipientAfter = balance(destinations[kind]);
    const poolAfter = balance(pool);
    if (reserveBefore[kind] - reserveAfter[kind] !== reserveBefore[kind] ||
        paidAfter[kind] - paidBefore[kind] !== reserveBefore[kind] ||
        recipientAfter - recipientBefore !== reserveBefore[kind] ||
        poolBefore - poolAfter !== reserveBefore[kind]) {
      throw new Error(`${kind} distribution submitted but balances did not reconcile`);
    }
    process.stdout.write(`${JSON.stringify({ kind, amount: reserveBefore[kind].toString(),
      recipient: destinations[kind], status: "verified" })}\n`);
  }
  if (!distributed) process.stdout.write(`${JSON.stringify({ status: "nothing-to-distribute" })}\n`);
}

function arg(argv: string[], key: string, fallback: string): string {
  const index = argv.indexOf(key);
  const value = index < 0 ? fallback : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
  return value;
}
