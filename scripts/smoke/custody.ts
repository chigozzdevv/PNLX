import { spawnSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerCommitment } from "@pnlx/crypto";
import { createCircuitMarginNote } from "@pnlx/sdk";
import { createAppAsync } from "@/app";
import { loadEnv, type ServerEnv } from "@/config/env";
import { stellarSignedMessageHash } from "@/features/auth/auth.service";
import { ProverService } from "@/workers/prover/prover.service";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_SECRET_KEY_VERSION = 18 << 3;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

interface CustodySmokeOptions {
  amount: bigint;
  asset?: string;
  deployAsset: boolean;
  from?: string;
  prepareOnly: boolean;
  source?: string;
  token?: string;
}

interface CustodyRuntime {
  from: string;
  source: string;
  token: string;
}

if (import.meta.main) {
  const result = await runCustodySmoke(parseCustodySmokeOptions());
  console.log(JSON.stringify(result, bigintReplacer, 2));
}

export function parseCustodySmokeOptions(argv = process.argv.slice(2)): CustodySmokeOptions {
  return {
    amount: BigInt(value(argv, "--amount", "1000000")),
    asset: optionalValue(argv, "--asset"),
    deployAsset: flag(argv, "--deploy-asset"),
    from: optionalValue(argv, "--from"),
    prepareOnly: flag(argv, "--prepare-only"),
    source: optionalValue(argv, "--source"),
    token: optionalValue(argv, "--token"),
  };
}

export function custodyReadinessIssues(
  env: Pick<
    ServerEnv,
    | "assetCustodyRequired"
    | "collateralTokenContract"
    | "stellarOnchainRelay"
    | "stellarRelayerMode"
  >,
): string[] {
  const issues: string[] = [];
  if (!env.assetCustodyRequired) {
    issues.push("ASSET_CUSTODY_REQUIRED must be true");
  }
  if (!env.collateralTokenContract) {
    issues.push("COLLATERAL_TOKEN_CONTRACT is required");
  }
  if (!env.stellarOnchainRelay) {
    issues.push("STELLAR_ONCHAIN_RELAY must be true");
  }
  if (env.stellarRelayerMode !== "stellar-cli") {
    issues.push("STELLAR_RELAYER_MODE must be stellar-cli");
  }
  return issues;
}

async function runCustodySmoke(options: CustodySmokeOptions): Promise<Record<string, unknown>> {
  const env = configureCustodySmokeEnvironment(options);
  const token = options.deployAsset
    ? deployAssetContract(options.asset ?? "native", env)
    : options.token ?? env.collateralTokenContract;
  if (!token) {
    throw new Error("set --token, COLLATERAL_TOKEN_CONTRACT, or use --deploy-asset");
  }

  process.env.COLLATERAL_TOKEN_CONTRACT = token;
  const configured = loadEnv();
  const issues = custodyReadinessIssues(configured);
  if (issues.length > 0) {
    throw new Error(`custody smoke is not live-ready: ${issues.join("; ")}`);
  }

  const source = options.source ?? configured.stellarSource;
  const from = options.from ?? resolveSourceAddress(source, configured);
  const deployment = await import("@/workers/onchain/deployment").then((module) =>
    module.loadDeploymentRegistry(configured.stellarDeploymentFile),
  );
  if (!deployment) throw new Error("deployment registry is not configured");
  const shieldedPool = deployment.contracts["shielded-pool"];
  if (!shieldedPool) throw new Error("deployment missing shielded-pool contract");
  const tokenDigest = tokenDigestFor(shieldedPool, token, source, configured);
  process.env.COLLATERAL_TOKEN_DIGEST = tokenDigest;

  const createdAt = Date.now();
  const spendSecret = `custody-smoke-spend-${createdAt}`;
  const rho = `custody-smoke-rho-${createdAt}`;
  const blindingSeed = `custody-smoke-blind-${createdAt}`;
  const note = createCircuitMarginNote({
    assetDigest: tokenDigest,
    assetId: "usdc",
    amount: options.amount,
    owner: from,
    spendSecret,
    rho,
    blinding: blindingSeed,
  });
  const depositProof = new ProverService().proveDepositNote({
    amount: options.amount,
    blinding: note.blinding,
    commitment: note.commitment,
    ownerDigest: note.ownerDigest,
    rhoDigest: note.rhoDigest,
    tokenDigest: note.assetDigest,
  });
  const app = await createAppAsync();
  const authHeaders = await authHeadersFor(app, source, from, configured);
  const health = await get(app, "/health");
  const prepared = await post(app, "/notes/deposit-asset/prepare-proven", {
    amount: options.amount,
    commitment: note.commitment,
    depositProof,
    from,
    source,
    token,
  }, authHeaders);
  if (options.prepareOnly) {
    return {
      amount: options.amount,
      from,
      health,
      mode: "prepare-only",
      noteCommitment: note.commitment,
      prepared: summarizePreparedDeposit(prepared),
      shieldedPool,
      source,
      token,
    };
  }

  const before = readBalances(token, from, shieldedPool, configured);
  const signedXdr = signPreparedXdr(prepared, source, configured);
  const relay = await post(app, "/relays/signed-xdr", {
    commitment: preparedPendingField(prepared, "commitment"),
    expectedTxHash: preparedPendingField(prepared, "preparedTxHash"),
    preparedXdrDigest: preparedPendingField(prepared, "preparedXdrDigest"),
    xdr: signedXdr,
  }, authHeaders);
  const deposit = await post(app, "/notes/deposit-asset/finalize", {
    amount: options.amount,
    commitment: note.commitment,
    depositProof,
    from,
    relayId: String((relay.relay as Record<string, unknown>).relayId),
    token,
  }, authHeaders);
  const after = waitForCustodyBalances(token, from, shieldedPool, before, options.amount, configured);
  const poolDelta = after.pool - before.pool;
  const traderDelta = after.trader - before.trader;
  const nativeAssetFeesIncluded = token === assetContractId("native", configured);
  const hasCommitment = waitForPoolCommitment(shieldedPool, note.commitment, source, configured);
  if (!hasCommitment) {
    throw new Error(`shielded pool did not record commitment ${note.commitment}`);
  }
  if (poolDelta !== options.amount) {
    throw new Error(`shielded pool balance delta ${poolDelta} did not match deposit ${options.amount}`);
  }
  if (!nativeAssetFeesIncluded && before.trader - after.trader !== options.amount) {
    throw new Error(`trader token debit ${before.trader - after.trader} did not match deposit ${options.amount}`);
  }
  const savedMakerNote = saveMakerNote({
    amount: options.amount,
    blinding: note.blinding,
    blindingSeed,
    commitment: note.commitment,
    createdAt,
    depositTxHash: String((relay.relay as Record<string, unknown>).txHash ?? ""),
    noteNullifier: note.noteNullifier,
    ownerCommitment: ownerCommitment(from),
    ownerDigest: note.ownerDigest,
    rho,
    rhoDigest: note.rhoDigest,
    shieldedPool,
    source,
    spendSecret,
    spendSecretDigest: note.spendSecretDigest,
    token,
    tokenDigest: note.assetDigest,
    walletAddress: from,
  });

  return {
    amount: options.amount,
    balances: {
      after,
      before,
      poolDelta,
      traderDelta,
    },
    deposit: summarizeFinalizedDeposit(deposit),
    from,
    health,
    mode: "live-wallet-deposit",
    makerNote: {
      amount: savedMakerNote.amount,
      commitment: savedMakerNote.commitment,
      file: makerNotesPath(),
      noteNullifier: savedMakerNote.noteNullifier,
      ownerCommitment: savedMakerNote.ownerCommitment,
      status: savedMakerNote.status,
    },
    noteCommitment: note.commitment,
    prepared: summarizePreparedDeposit(prepared),
    relay: summarizeRelay(relay.relay as Record<string, unknown>),
    shieldedPool,
    source,
    token,
    verified: {
      commitment: hasCommitment,
      poolReceivedAmount: poolDelta === options.amount,
      traderDebitedAtLeastAmount: nativeAssetFeesIncluded
        ? "native asset balance includes fees/reserves; pool delta is authoritative"
        : before.trader - after.trader >= options.amount,
      traderTokenDebitMatchesAmount: nativeAssetFeesIncluded
        ? "native asset balance includes Soroban transaction fees"
        : before.trader - after.trader === options.amount,
    },
  };
}

function saveMakerNote(input: {
  amount: bigint;
  blinding: string;
  blindingSeed: string;
  commitment: string;
  createdAt: number;
  depositTxHash: string;
  noteNullifier: string;
  ownerCommitment: string;
  ownerDigest: string;
  rho: string;
  rhoDigest: string;
  shieldedPool: string;
  source: string;
  spendSecret: string;
  spendSecretDigest: string;
  token: string;
  tokenDigest: string;
  walletAddress: string;
}): Record<string, string | number> {
  const path = makerNotesPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const existing = readMakerNotes(path);
  const note = {
    amount: input.amount.toString(),
    assetDigest: input.tokenDigest,
    blinding: input.blinding,
    blindingSeed: input.blindingSeed,
    commitment: input.commitment,
    createdAt: input.createdAt,
    depositTxHash: input.depositTxHash,
    noteNullifier: input.noteNullifier,
    ownerCommitment: input.ownerCommitment,
    ownerDigest: input.ownerDigest,
    rho: input.rho,
    rhoDigest: input.rhoDigest,
    shieldedPool: input.shieldedPool,
    source: input.source,
    spendSecret: input.spendSecret,
    spendSecretDigest: input.spendSecretDigest,
    status: "available",
    token: input.token,
    updatedAt: Date.now(),
    walletAddress: input.walletAddress,
  };
  writeFileSync(
    path,
    `${JSON.stringify([
      note,
      ...existing.filter((entry) => entry.commitment !== note.commitment),
    ], null, 2)}\n`,
    { mode: 0o600 },
  );
  return note;
}

function readMakerNotes(path: string): Array<Record<string, string | number>> {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is Record<string, string | number> =>
          Boolean(entry && typeof entry === "object" && "commitment" in entry)
        )
      : [];
  } catch {
    return [];
  }
}

function makerNotesPath(): string {
  return join(process.env.PNLX_RUNTIME_DIR || ".pnlx", "maker-notes.json");
}

function signPreparedXdr(prepared: Record<string, unknown>, source: string, env: ServerEnv): string {
  const action = prepared.action as Record<string, unknown> | undefined;
  const xdr = String(action?.xdr ?? "").trim();
  if (!xdr) throw new Error("prepared deposit action did not include xdr");
  return parseXdr(
    runCommand([
      "stellar",
      "tx",
      "sign",
      xdr,
      "--sign-with-key",
      source,
      "--network",
      env.stellarNetwork,
      ...networkArgs(env),
      "--network-passphrase",
      env.stellarNetworkPassphrase,
      "--auto-sign",
    ]),
    "signed transaction xdr",
  );
}

function summarizePreparedDeposit(prepared: Record<string, unknown>): Record<string, unknown> {
  const action = prepared.action as Record<string, unknown> | undefined;
  const pending = prepared.pendingDeposit as Record<string, unknown> | undefined;
  const verification = prepared.proofVerification as Record<string, unknown> | undefined;
  const relays = Array.isArray(verification?.relays) ? verification.relays : [];
  return {
    action: {
      contractId: action?.contractId,
      functionName: action?.functionName,
      kind: action?.kind,
      preparedTxHash: action?.txHash ?? pending?.preparedTxHash,
    },
    pendingDeposit: pending
      ? {
          amount: pending.amount,
          commitment: pending.commitment,
          from: pending.from,
          preparedTxHash: pending.preparedTxHash,
          preparedXdrDigest: pending.preparedXdrDigest,
          token: pending.token,
          tokenDigest: pending.tokenDigest,
        }
      : undefined,
    proofVerification: {
      relays: relays.map((relay) => summarizeRelay(relay as Record<string, unknown>)),
    },
  };
}

function summarizeRelay(relay: Record<string, unknown>): Record<string, unknown> {
  return {
    functionName: relay.functionName,
    kind: relay.kind,
    relayId: relay.relayId,
    submitted: relay.submitted,
    txHash: relay.txHash,
  };
}

function summarizeFinalizedDeposit(deposit: Record<string, unknown>): Record<string, unknown> {
  const note = deposit.note as Record<string, unknown> | undefined;
  const onchain = note?.onchain as Record<string, unknown> | undefined;
  const relays = Array.isArray(onchain?.relays) ? onchain.relays : [];
  return {
    amount: note?.amount,
    commitment: note?.commitment,
    marginRoot: note?.marginRoot,
    membershipRoot: note?.membershipRoot,
    onchain: {
      relays: relays.map((relay) => summarizeRelay(relay as Record<string, unknown>)),
    },
    token: note?.token,
  };
}

function preparedPendingField(prepared: Record<string, unknown>, field: string): string {
  const pending = prepared.pendingDeposit as Record<string, unknown> | undefined;
  const value = pending?.[field];
  if (typeof value !== "string" || !value) throw new Error(`prepared pending deposit missing ${field}`);
  return value;
}

function configureCustodySmokeEnvironment(options: CustodySmokeOptions): ServerEnv {
  const runtimeDir = mkdtempSync(join(tmpdir(), "pnlx-custody-smoke-"));
  process.env.ASSET_CUSTODY_REQUIRED = "true";
  process.env.STELLAR_ONCHAIN_RELAY = "true";
  process.env.STELLAR_RELAYER_MODE = "stellar-cli";
  process.env.FUNDING_ENGINE_ENABLED = process.env.FUNDING_ENGINE_ENABLED || "false";
  process.env.PROTOCOL_STORE_PATH ??= join(runtimeDir, "protocol-store.json");
  process.env.RELAY_STORE_PATH ??= join(runtimeDir, "relay-store.json");
  process.env.AUTH_STORE_PATH ??= join(runtimeDir, "auth-store.json");
  if (options.source) process.env.STELLAR_SOURCE = options.source;
  if (options.token) process.env.COLLATERAL_TOKEN_CONTRACT = options.token;
  return loadEnv();
}

function deployAssetContract(asset: string, env: ServerEnv): string {
  const command = [
    "stellar",
    "contract",
    "asset",
    "deploy",
    "--asset",
    asset,
    "--source-account",
    env.stellarSource,
    "--network",
    env.stellarNetwork,
    ...networkArgs(env),
    "--network-passphrase",
    env.stellarNetworkPassphrase,
  ];
  const output = runCommandAllowingExistingValue(command) ?? assetContractId(asset, env);
  return parseContractId(output, `asset ${asset}`);
}

function assetContractId(asset: string, env: ServerEnv): string {
  return runCommand([
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
  ]).trim();
}

function readBalances(
  token: string,
  from: string,
  shieldedPool: string,
  env: ServerEnv,
): { pool: bigint; trader: bigint } {
  return {
    pool: readTokenBalance(token, shieldedPool, from, env),
    trader: readTokenBalance(token, from, from, env),
  };
}

function waitForCustodyBalances(
  token: string,
  from: string,
  shieldedPool: string,
  before: { pool: bigint; trader: bigint },
  amount: bigint,
  env: ServerEnv,
): { pool: bigint; trader: bigint } {
  let latest = readBalances(token, from, shieldedPool, env);
  for (let attempt = 1; attempt < 12 && latest.pool - before.pool !== amount; attempt += 1) {
    sleep(2_500);
    latest = readBalances(token, from, shieldedPool, env);
  }
  return latest;
}

function readTokenBalance(token: string, account: string, source: string, env: ServerEnv): bigint {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const output = invoke(token, "balance", ["--id", account], source, env, "no");
      return BigInt(output.trim().match(/-?\d+/)?.[0] ?? "0");
    } catch (error) {
      lastError = error;
      if (!isTransientStellarReadFailure(error) || attempt === 4) break;
      sleep(2_500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("token balance read failed");
}

function hasPoolCommitment(
  shieldedPool: string,
  commitment: string,
  source: string,
  env: ServerEnv,
): boolean {
  const output = invoke(
    shieldedPool,
    "has_commitment",
    ["--commitment", bytes32(commitment)],
    source,
    env,
    "no",
  );
  return output.trim() === "true";
}

function waitForPoolCommitment(
  shieldedPool: string,
  commitment: string,
  source: string,
  env: ServerEnv,
): boolean {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      if (hasPoolCommitment(shieldedPool, commitment, source, env)) return true;
    } catch (error) {
      if (!isTransientStellarReadFailure(error)) throw error;
    }
    sleep(2_500);
  }
  return false;
}

function isTransientStellarReadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Request timeout") || message.includes("client error (Connect)");
}

function tokenDigestFor(
  shieldedPool: string,
  token: string,
  source: string,
  env: ServerEnv,
): `0x${string}` {
  const output = invoke(shieldedPool, "token_digest", ["--token", token], source, env, "no");
  return parseHex32(output, `token digest for ${token}`);
}

type SmokeApp = Awaited<ReturnType<typeof createAppAsync>>;

async function get(app: SmokeApp, path: string): Promise<Record<string, unknown>> {
  const response = await app.handle(new Request(`http://pnlx.local${path}`));
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function post(
  app: SmokeApp,
  path: string,
  data: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Record<string, unknown>> {
  const response = await app.handle(
    new Request(`http://pnlx.local${path}`, {
      method: "POST",
      body: JSON.stringify(data, bigintReplacer),
      headers,
    }),
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function authHeadersFor(
  app: SmokeApp,
  source: string,
  address: string,
  env: ServerEnv,
): Promise<Record<string, string>> {
  if (!env.authRequired) return { "content-type": "application/json" };
  if (/^G[A-Z0-9]{55}$/.test(source)) {
    throw new Error("AUTH_REQUIRED=true needs --source to be a local Stellar key alias, not only a public address");
  }

  const secret = runCommand(["stellar", "keys", "secret", source]).trim();
  const challenge = await post(app, "/auth/challenge", {
    address,
    domain: "pnlx.local",
    uri: "http://pnlx.local",
  });
  const message = String(challenge.message);
  const signature = sign(null, stellarSignedMessageHash(message), privateKeyFromStellarSecret(secret)).toString("base64");
  const session = await post(app, "/auth/session", {
    address,
    nonce: challenge.nonce,
    signature,
  });
  return {
    authorization: `Bearer ${session.token}`,
    "content-type": "application/json",
  };
}

function privateKeyFromStellarSecret(secret: string) {
  const decoded = base32Decode(secret.trim());
  if (decoded.length !== 35) throw new Error("invalid stellar secret length");
  const payload = decoded.subarray(0, 33);
  const checksum = decoded.subarray(33);
  const expected = crc16Xmodem(payload);
  if (checksum[0] !== (expected & 0xff) || checksum[1] !== (expected >> 8)) {
    throw new Error("invalid stellar secret checksum");
  }
  if (payload[0] !== ED25519_SECRET_KEY_VERSION) {
    throw new Error("invalid stellar secret version");
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, payload.subarray(1)]),
    format: "der",
    type: "pkcs8",
  });
}

function invoke(
  contractId: string,
  method: string,
  args: string[],
  source: string,
  env: ServerEnv,
  send: "no" | "yes",
): string {
  return runCommand([
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
    ...(send === "yes" ? ["--auto-sign"] : []),
    "--",
    method,
    ...args,
  ]);
}

function networkArgs(env: ServerEnv): string[] {
  return [
    ...(env.stellarRpcUrl ? ["--rpc-url", env.stellarRpcUrl] : []),
  ];
}

function resolveSourceAddress(source: string, env: ServerEnv): string {
  if (/^G[A-Z0-9]{55}$/.test(source)) return source;
  void env;
  const output = runCommand(["stellar", "keys", "address", source]);
  const address = output.match(/\bG[A-Z0-9]{55}\b/)?.[0];
  if (!address) throw new Error(`could not resolve source address for ${source}`);
  return address;
}

function runCommand(command: string[]): string {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0) {
    throw new Error(`${command.map(quote).join(" ")} failed\n${output}`);
  }
  return output;
}

function runCommandAllowingExistingValue(command: string[]): string | undefined {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status === 0) return output;
  if (output.includes("ExistingValue") || output.includes("contract already exists")) {
    return undefined;
  }
  throw new Error(`${command.map(quote).join(" ")} failed\n${output}`);
}

function parseContractId(output: string, label: string): string {
  const id = output.match(/\bC[A-Z0-9]{55}\b/)?.[0];
  if (!id) throw new Error(`could not parse contract id for ${label}`);
  return id;
}

function parseHex32(output: string, label: string): `0x${string}` {
  const value = output.match(/(?:0x)?[0-9a-fA-F]{64}/)?.[0];
  if (!value) throw new Error(`could not parse ${label}`);
  return value.startsWith("0x") ? (value.toLowerCase() as `0x${string}`) : `0x${value.toLowerCase()}`;
}

function parseXdr(output: string, label: string): string {
  const candidates = output
    .split(/\s+/)
    .filter((part) => /^[A-Za-z0-9+/=]+$/.test(part) && part.length > 80)
    .sort((a, b) => b.length - a.length);
  if (!candidates[0]) throw new Error(`could not parse ${label}`);
  return candidates[0];
}

function optionalValue(argv: string[], name: string): string | undefined {
  const entry = argv.find((arg) => arg.startsWith(`${name}=`));
  if (entry) return entry.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function value(argv: string[], name: string, fallback: string): string {
  return optionalValue(argv, name) ?? fallback;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function bytes32(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function base32Decode(value: string): Buffer {
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (const char of value.replace(/=+$/g, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid stellar secret character");
    bits = (bits << 5) | index;
    bitCount += 5;
    while (bitCount >= 8) {
      bytes.push((bits >> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }

  return Buffer.from(bytes);
}

function crc16Xmodem(value: Buffer): number {
  let crc = 0;
  for (const byte of value) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
