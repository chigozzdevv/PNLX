import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient } from "@/shared/mongo/client";
import { loadEnv } from "@/config/env";

interface Grant {
  _id: string;
  contractId: string;
  grantId: string;
  kind: number;
  owner: string;
}

if (import.meta.main) await keepaliveRewards(process.argv.slice(2));

export async function keepaliveRewards(argv: string[]): Promise<void> {
  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || !env.mongodbUri) throw new Error("Testnet MongoDB is required");
  const registry = JSON.parse(readFileSync(resolve(env.stellarDeploymentFile), "utf8")) as
    { contracts: Record<string, string>; network: string };
  const escrow = registry.contracts["rewards-escrow"];
  if (registry.network !== "testnet" || !escrow) throw new Error("rewards escrow is not deployed");
  const source = required(argv, "--source");
  const execute = argv.includes("--execute");
  const mongo = new MongoClient(env.mongodbUri);
  let grants: Grant[];
  try {
    await mongo.connect();
    grants = await mongo.db(env.mongodbDatabase).collection<Grant>("reward_grants")
      .find({ contractId: escrow }).toArray();
  } finally { await mongo.close(); }
  const accounts = [...new Set(grants.map((grant) => `${grant.owner}:${grant.kind}`))];
  process.stdout.write(`${JSON.stringify({ escrow, accounts: accounts.length, grants: grants.length,
    status: execute ? "executing" : "dry-run" })}\n`);
  if (!execute) return;
  invoke("keepalive_instance", []);
  for (const entry of accounts) {
    const index = entry.lastIndexOf(":");
    invoke("keepalive_credit", ["--owner", entry.slice(0, index), "--kind", entry.slice(index + 1)]);
  }
  for (const grant of grants) {
    if (parseBoolean(read("credited", ["--grant_id", grant.grantId]))) {
      invoke("keepalive_grant", ["--grant_id", grant.grantId]);
    }
  }
  process.stdout.write(`${JSON.stringify({ escrow, status: "verified" })}\n`);

  function read(method: string, args: string[]): string {
    return run(["stellar", "contract", "invoke", "--id", escrow, "--source", source,
      "--network", "testnet", "--send", "no", "--", method, ...args]);
  }

  function invoke(method: string, args: string[]): void {
    run(["stellar", "contract", "invoke", "--id", escrow, "--source", source,
      "--network", "testnet", "--send", "yes", "--auto-sign", "--", method, ...args]);
  }
}

function parseBoolean(output: string): boolean {
  const value = JSON.parse(output.trim()) as unknown;
  if (typeof value !== "boolean") throw new Error("invalid reward grant status");
  return value;
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
