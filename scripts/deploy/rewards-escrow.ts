import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Registry {
  contracts: Record<string, string>;
  feeDestinations: { treasury: string };
  network: string;
  upgradeAuthority: string;
  wasmHashes?: Record<string, string>;
}

interface Options {
  asset: string;
  dryRun: boolean;
  registry: string;
  source: string;
  wasm: string;
}

if (import.meta.main) deployRewardsEscrow(parseOptions(process.argv.slice(2)));

export function parseOptions(argv: string[]): Options {
  return {
    asset: value(argv, "--asset", process.env.COLLATERAL_TOKEN_CONTRACT ?? ""),
    dryRun: argv.includes("--dry-run"),
    registry: value(argv, "--registry", "deployments/testnet.json"),
    source: value(argv, "--source", ""),
    wasm: value(argv, "--wasm", "contracts/target/stellar/rewards_escrow.wasm"),
  };
}

export function deployRewardsEscrow(options: Options): void {
  const path = resolve(options.registry);
  const checkpoint = `${path}.rewards.partial`;
  const registry = JSON.parse(readFileSync(path, "utf8")) as Registry;
  if (registry.network !== "testnet") throw new Error("rewards escrow deployment is Testnet-only");
  if (registry.contracts["rewards-escrow"]) throw new Error("rewards escrow is already deployed");
  const feePool = registry.contracts["shielded-pool"];
  if (!/^C[A-Z2-7]{55}$/.test(feePool ?? "")) throw new Error("a deployed fee pool is required");
  if (existsSync(checkpoint)) throw new Error(`unfinished rewards escrow deployment: ${checkpoint}`);
  if (!/^C[A-Z2-7]{55}$/.test(options.asset) || !existsSync(options.wasm)) {
    throw new Error("a built rewards escrow and valid USDC contract are required");
  }
  if (!options.source) throw new Error("treasury source alias is required");
  const treasury = /^G[A-Z2-7]{55}$/.test(options.source)
    ? options.source : run(["stellar", "keys", "address", options.source]).trim();
  if (treasury !== registry.feeDestinations.treasury || !/^G[A-Z2-7]{55}$/.test(registry.upgradeAuthority) ||
    treasury === registry.upgradeAuthority) {
    throw new Error("rewards escrow must use the configured treasury and a separate upgrade authority");
  }

  const command = ["stellar", "contract", "deploy", "--wasm", options.wasm, "--source", options.source,
    "--network", "testnet", "--auto-sign", "--", "--token", options.asset,
    "--treasury", treasury, "--upgrade_authority", registry.upgradeAuthority, "--fee_pool", feePool];
  if (options.dryRun) { process.stdout.write(`${command.join(" ")}\n`); return; }
  const output = run(command);
  const id = output.match(/\bC[A-Z2-7]{55}\b/)?.[0];
  if (!id) throw new Error(`rewards escrow deployment returned no contract id: ${output}`);
  writeFileSync(checkpoint, `${JSON.stringify({ id, asset: options.asset, treasury }, null, 2)}\n`);
  for (const [method, expected] of [["token", options.asset], ["treasury", treasury], ["fee_pool", feePool],
    ["upgrade_authority", registry.upgradeAuthority], ["available", "0"], ["liability", "0"]]) {
    const actual = parse(run(["stellar", "contract", "invoke", "--id", id, "--source", options.source,
      "--network", "testnet", "--send", "no", "--", method]));
    if (String(actual) !== expected) throw new Error(`${method} verification failed for ${id}`);
  }
  const current = JSON.parse(readFileSync(path, "utf8")) as Registry;
  if (current.contracts["rewards-escrow"]) throw new Error("rewards escrow was registered during deployment");
  current.contracts["rewards-escrow"] = id;
  current.wasmHashes ??= {};
  current.wasmHashes["rewards-escrow"] = `0x${createHash("sha256").update(readFileSync(options.wasm)).digest("hex")}`;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`);
  renameSync(temporary, path);
  unlinkSync(checkpoint);
  process.stdout.write(`${id}\n`);
}

function value(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
  return result;
}

function parse(output: string): unknown {
  try { return JSON.parse(output.trim()); } catch { return output.trim(); }
}

function run(command: string[]): string {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
