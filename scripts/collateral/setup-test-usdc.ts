import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "@/config/env";

interface Options {
  amount: bigint;
  assetCode: string;
  issuer: string;
  recipient: string;
  writeEnv: boolean;
}

const root = process.cwd();

if (import.meta.main) {
  const result = setupTestUsdc(parseOptions());
  console.log(JSON.stringify(result, bigintReplacer, 2));
}

export function parseOptions(argv = process.argv.slice(2)): Options {
  return {
    amount: BigInt(value(argv, "--amount", "100000000000")),
    assetCode: value(argv, "--asset-code", "USDC"),
    issuer: value(argv, "--issuer", "pnlx-usdc-issuer"),
    recipient: value(argv, "--recipient", "pnlx-testnet"),
    writeEnv: flag(argv, "--write-env"),
  };
}

export function setupTestUsdc(options: Options): Record<string, unknown> {
  const env = loadEnv();
  ensureKey(options.issuer, env);
  fundKey(options.issuer, env);
  fundKey(options.recipient, env);

  const issuerAddress = resolveAddress(options.issuer);
  const recipientAddress = resolveAddress(options.recipient);
  const asset = `${options.assetCode}:${issuerAddress}`;
  const token = deployAssetContract(asset, options.recipient, env);
  const before = balance(token, recipientAddress, options.recipient, env);

  if (options.amount > 0n) {
    invoke(token, "transfer", [
      "--from",
      issuerAddress,
      "--to",
      recipientAddress,
      "--amount",
      options.amount.toString(),
    ], options.issuer, env, "yes");
  }

  const after = balance(token, recipientAddress, options.recipient, env);
  if (options.writeEnv) {
    updateEnv({
      COLLATERAL_ASSET: asset,
      COLLATERAL_ASSET_CODE: options.assetCode,
      COLLATERAL_ASSET_ISSUER: issuerAddress,
      COLLATERAL_TOKEN_CONTRACT: token,
    });
  }

  return {
    afterBalance: after,
    asset,
    beforeBalance: before,
    fundedAmount: after - before,
    issuer: issuerAddress,
    recipient: recipientAddress,
    token,
    wroteEnv: options.writeEnv,
  };
}

function ensureKey(alias: string, env: ReturnType<typeof loadEnv>): void {
  const existing = spawnSync("stellar", ["keys", "address", alias], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (existing.status === 0) return;

  run([
    "stellar",
    "keys",
    "generate",
    alias,
    "--network",
    env.stellarNetwork,
  ], false);
}

function fundKey(alias: string, env: ReturnType<typeof loadEnv>): void {
  run([
    "stellar",
    "keys",
    "fund",
    alias,
    "--network",
    env.stellarNetwork,
    ...networkArgs(env),
    "--network-passphrase",
    env.stellarNetworkPassphrase,
  ], true);
}

function deployAssetContract(
  asset: string,
  source: string,
  env: ReturnType<typeof loadEnv>,
): string {
  let output = "";
  try {
    output = run([
      "stellar",
      "contract",
      "asset",
      "deploy",
      "--asset",
      asset,
      "--source-account",
      source,
      "--network",
      env.stellarNetwork,
      ...networkArgs(env),
      "--network-passphrase",
      env.stellarNetworkPassphrase,
      "--alias",
      "pnlx-test-usdc",
      "--auto-sign",
    ], true);
  } catch (error) {
    if (!/already exists|already installed|existing/i.test(String((error as Error).message))) {
      throw error;
    }
  }
  const contract = output.match(/\bC[A-Z0-9]{55}\b/)?.[0] ?? assetContractId(asset, env);
  if (!contract) throw new Error(`could not resolve asset contract for ${asset}`);
  return contract;
}

function assetContractId(asset: string, env: ReturnType<typeof loadEnv>): string {
  return run([
    "stellar",
    "contract",
    "id",
    "asset",
    "--asset",
    asset,
    "--network",
    env.stellarNetwork,
    ...networkArgs(env),
    "--network-passphrase",
    env.stellarNetworkPassphrase,
  ], false).trim();
}

function balance(
  token: string,
  account: string,
  source: string,
  env: ReturnType<typeof loadEnv>,
): bigint {
  const output = invoke(token, "balance", ["--id", account], source, env, "no");
  return BigInt(output.match(/-?\d+/)?.[0] ?? "0");
}

function invoke(
  contractId: string,
  method: string,
  args: string[],
  source: string,
  env: ReturnType<typeof loadEnv>,
  send: "yes" | "no",
): string {
  return run([
    "stellar",
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    source,
    "--network",
    env.stellarNetwork,
    ...networkArgs(env),
    "--network-passphrase",
    env.stellarNetworkPassphrase,
    "--send",
    send,
    "--auto-sign",
    "--",
    method,
    ...args,
  ], true);
}

function resolveAddress(aliasOrAddress: string): string {
  if (/^G[A-Z0-9]{55}$/.test(aliasOrAddress)) return aliasOrAddress;
  const output = run(["stellar", "keys", "address", aliasOrAddress], false);
  const address = output.match(/\bG[A-Z0-9]{55}\b/)?.[0];
  if (!address) throw new Error(`could not resolve address for ${aliasOrAddress}`);
  return address;
}

function updateEnv(updates: Record<string, string>): void {
  const path = join(root, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next = existing.map((line) => {
    const key = line.split("=", 1)[0];
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, entry] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${entry}`);
  }
  writeFileSync(path, `${next.join("\n").replace(/\n+$/, "")}\n`);
}

function run(command: string[], allowTransientFailure: boolean): string {
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90_000,
    });
    last = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.status === 0) return last;
    if (
      allowTransientFailure &&
      /already exists|txbadseq|tx_bad_seq|try_again_later|timeout|rate limit/i.test(last)
    ) {
      sleep(2_500 * attempt);
      continue;
    }
    break;
  }
  throw new Error(`${command.join(" ")} failed\n${last}`);
}

function networkArgs(env: ReturnType<typeof loadEnv>): string[] {
  return env.stellarRpcUrl ? ["--rpc-url", env.stellarRpcUrl] : [];
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function value(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
