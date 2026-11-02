import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "@/config/env";
import { RewardRequestRegistry } from "@/features/rewards/rewards.requests";
import { creditRewards } from "./credit-rewards";

if (import.meta.main) await processRewardRequests(process.argv.slice(2));

export async function processRewardRequests(argv: string[]): Promise<void> {
  const env = loadEnv({ validateRuntime: false });
  if (env.stellarNetwork !== "testnet" || !env.mongodbUri) throw new Error("Testnet MongoDB is required");
  const registry = JSON.parse(readFileSync(resolve(env.stellarDeploymentFile), "utf8")) as
    { contracts: Record<string, string>; network: string };
  const escrow = registry.contracts["rewards-escrow"];
  if (registry.network !== "testnet" || !escrow) throw new Error("rewards escrow is not deployed");
  const source = required(argv, "--treasury-source");
  const execute = argv.includes("--execute");
  const requests = new RewardRequestRegistry({ uri: env.mongodbUri, database: env.mongodbDatabase });
  const pending = await requests.pending(escrow);
  process.stdout.write(`${JSON.stringify({ count: pending.length, status: execute ? "executing" : "dry-run" })}\n`);
  let failed = 0;
  for (const request of pending) {
    try {
      await creditRewards(["--owner", request.owner, "--kind", request.kind,
        "--treasury-source", source, ...(execute ? ["--execute"] : [])]);
      if (execute) await requests.complete(request._id);
    } catch (error) {
      failed += 1;
      process.stderr.write(`${JSON.stringify({ request: request._id,
        error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  if (failed) throw new Error(`${failed} reward requests remain pending`);
}

function required(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? "" : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}
