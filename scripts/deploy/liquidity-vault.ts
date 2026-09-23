import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Registry {
  contracts: Record<string, string>;
  network: string;
  source: string;
  sourceAddress: string;
  upgradeAuthority?: string;
  wasmHashes?: Record<string, string>;
  [key: string]: unknown;
}

interface Options {
  alias: string;
  allocationLimitBps: number;
  asset: string;
  dryRun: boolean;
  maker: string;
  registry: string;
  source: string;
  upgradeAuthority: string;
  wasm: string;
}

if (import.meta.main) {
  deployLiquidityVault(parseOptions(process.argv.slice(2)));
}

export function parseOptions(argv: string[]): Options {
  return {
    alias: value(argv, "--alias", "pnlx-liquidity-vault"),
    allocationLimitBps: Number(value(argv, "--allocation-limit-bps", "8000")),
    asset: value(argv, "--asset", process.env.COLLATERAL_TOKEN_CONTRACT ?? ""),
    dryRun: argv.includes("--dry-run"),
    maker: value(argv, "--maker", ""),
    registry: value(argv, "--registry", "deployments/testnet.json"),
    source: value(argv, "--source", ""),
    upgradeAuthority: value(argv, "--upgrade-authority", ""),
    wasm: value(argv, "--wasm", "contracts/target/stellar/liquidity_vault.wasm"),
  };
}

export function deployLiquidityVault(options: Options): void {
  const registryPath = resolve(options.registry);
  const checkpointPath = `${registryPath}.vault.partial`;
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  if (registry.network !== "testnet") throw new Error("liquidity vault deployment is Testnet-only");
  if (registry.contracts["liquidity-vault"]) throw new Error("liquidity vault is already registered");
  if (existsSync(checkpointPath)) throw new Error(`unfinished vault deployment: ${checkpointPath}`);
  const source = options.source;
  if (!source) throw new Error("dedicated vault operator source is required");
  if (!/^C[A-Z2-7]{55}$/.test(options.asset)) throw new Error("valid USDC asset contract is required");
  if (process.env.COLLATERAL_TOKEN_CONTRACT && options.asset !== process.env.COLLATERAL_TOKEN_CONTRACT) {
    throw new Error("vault asset must match the configured collateral token contract");
  }
  if (!Number.isInteger(options.allocationLimitBps) || options.allocationLimitBps < 1 || options.allocationLimitBps > 8000) {
    throw new Error("allocation limit must be 1..8000 basis points");
  }
  if (!existsSync(options.wasm)) throw new Error(`missing vault WASM: ${options.wasm}`);

  const operator = /^G[A-Z2-7]{55}$/.test(source)
    ? source
    : run(["stellar", "keys", "address", source]).trim();
  if (!/^G[A-Z2-7]{55}$/.test(operator)) throw new Error("could not resolve operator address");
  if (operator === registry.sourceAddress) throw new Error("use a separate vault maker account");
  const maker = options.maker || operator;
  if (maker !== operator) throw new Error("maker must equal the vault operator account");
  const upgradeCandidate = options.upgradeAuthority || registry.upgradeAuthority;
  if (!upgradeCandidate) throw new Error("--upgrade-authority is required");
  const upgradeAuthority = /^G[A-Z2-7]{55}$/.test(upgradeCandidate)
    ? upgradeCandidate
    : run(["stellar", "keys", "address", upgradeCandidate]).trim();
  if (!/^G[A-Z2-7]{55}$/.test(upgradeAuthority) || upgradeAuthority === operator || upgradeAuthority === registry.sourceAddress) {
    throw new Error("upgrade authority must be a separate Stellar account");
  }

  const deployCommand = [
    "stellar", "contract", "deploy", "--wasm", options.wasm,
    "--source", source, "--network", "testnet", "--alias", options.alias, "--auto-sign",
    "--", "--asset", options.asset, "--operator", operator, "--maker", maker,
    "--allocation_limit_bps", String(options.allocationLimitBps),
  ];
  if (options.dryRun) {
    process.stdout.write(`${deployCommand.join(" ")}\n`);
    return;
  }

  const deployed = run(deployCommand);
  const id = deployed.match(/\bC[A-Z2-7]{55}\b/)?.[0];
  if (!id) throw new Error(`vault deployment returned no contract id: ${deployed}`);
  writeFileSync(checkpointPath, `${JSON.stringify({ id, asset: options.asset, operator, upgradeAuthority }, null, 2)}\n`);
  run([
    "stellar", "contract", "invoke", "--id", id, "--source", source,
    "--network", "testnet", "--send", "yes", "--auto-sign", "--",
    "set_upgrade_authority", "--authority", upgradeAuthority,
  ]);

  for (const [method, expected] of [
    ["asset", options.asset],
    ["operator", operator],
    ["maker", maker],
    ["allocation_limit_bps", String(options.allocationLimitBps)],
    ["paused", "true"],
    ["upgrade_authority", upgradeAuthority],
  ]) {
    const output = run([
      "stellar", "contract", "invoke", "--id", id, "--source", source,
      "--network", "testnet", "--send", "no", "--", method,
    ]);
    if (String(parseOutput(output)) !== expected) {
      throw new Error(`vault ${id} ${method} verification failed`);
    }
  }

  const current = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  if (current.contracts["liquidity-vault"]) throw new Error("liquidity vault was registered during deployment");
  current.contracts["liquidity-vault"] = id;
  current.wasmHashes ??= {};
  current.wasmHashes["liquidity-vault"] = `0x${createHash("sha256").update(readFileSync(options.wasm)).digest("hex")}`;
  const pendingRegistryPath = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(pendingRegistryPath, `${JSON.stringify(current, null, 2)}\n`);
  renameSync(pendingRegistryPath, registryPath);
  unlinkSync(checkpointPath);
  process.stdout.write(`${id}\n`);
}

function value(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output.trim());
  } catch {
    return output.trim();
  }
}

function run(command: string[]): string {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command.slice(0, 3).join(" ")}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
