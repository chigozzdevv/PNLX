import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fieldMerkleRoot } from "@merkl/crypto";
import { circuitKey } from "@merkl/proof-system";
import type { Hex } from "@merkl/protocol-types";
import { loadEnv } from "../../server/src/config/env";
import { createDeployManifest } from "./manifest";

interface Options {
  aliasPrefix: string;
  build: boolean;
  dryRun: boolean;
  network: string;
  out?: string;
  setupLocal: boolean;
  smoke: boolean;
  source: string;
}

interface Deployment {
  contracts: Record<string, string>;
  network: string;
  source: string;
  sourceAddress: string;
  verifiers: Record<string, string>;
}

const LOCAL_PASSPHRASE = "Standalone Network ; February 2017";
const LOCAL_RPC = "http://localhost:8000/soroban/rpc";
const INITIAL_POSITION_ROOT = fieldMerkleRoot([]);

export function parseOptions(argv = process.argv.slice(2)): Options {
  return {
    aliasPrefix: value(argv, "--alias-prefix", "merkl"),
    build: flag(argv, "--build"),
    dryRun: flag(argv, "--dry-run"),
    network: value(argv, "--network", "local"),
    out: optionalValue(argv, "--out"),
    setupLocal: flag(argv, "--setup-local"),
    smoke: !flag(argv, "--no-smoke"),
    source: value(argv, "--source", "merkl-admin"),
  };
}

export function commandPlan(options: Options, root = process.cwd()): string[][] {
  const commands: string[][] = [];
  const manifest = createDeployManifest(root, {
    requireContracts: false,
    requireVerifierKeys: false,
  });
  const env = loadEnv();
  const sourceAddress = sourceAddressCommand(options.source);

  if (options.build) {
    commands.push(["bun", "run", "prove:circuits"]);
    commands.push(["bun", "run", "build:contracts"]);
  }
  if (options.setupLocal) {
    commands.push(...localSetupCommands(options));
  }
  for (const contract of deployableContracts(manifest)) {
    commands.push(deployCommand(options, contract.path, `${options.aliasPrefix}-${contract.name}`));
  }
  for (const verifier of manifest.verifiers) {
    commands.push(
      deployCommand(options, proofVerifierPath(manifest), `${options.aliasPrefix}-${verifier.verifierAuthority}`),
    );
  }

  commands.push(sourceAddress);
  commands.push(
    invokeCommand(options, "governance", "init", ["--admin", "$sourceAddress"]),
    invokeCommand(options, "proof-ledger", "init", ["--governance", "$governance"]),
    invokeCommand(options, "price-oracle", "init", [
      "--admin",
      "$sourceAddress",
      "--decimals",
      String(env.oraclePriceDecimals),
    ]),
  );

  for (const verifier of manifest.verifiers) {
    commands.push(
      invokeCommand(options, verifier.verifierAuthority, "init", [
        "--governance",
        "$governance",
        "--proof_ledger",
        "$proof-ledger",
        "--circuit_id",
        bytes32(verifier.circuitKey),
        "--verifier_hash",
        bytes32(verifier.verifierHash),
        "--vk_bytes-file-path",
        verifier.vkPath,
      ]),
      invokeCommand(options, "governance", "set_verifier", [
        "--circuit_id",
        bytes32(verifier.circuitKey),
        "--verifier_hash",
        bytes32(verifier.verifierHash),
        "--authority",
        `$${verifier.verifierAuthority}`,
      ]),
    );
  }

  commands.push(
    invokeCommand(options, "shielded-pool", "init", [
      "--governance",
      "$governance",
      "--proof_ledger",
      "$proof-ledger",
      "--deposit_circuit_id",
      bytes32(circuitKey("deposit-note")),
      "--withdraw_circuit_id",
      bytes32(circuitKey("withdraw")),
    ]),
    invokeCommand(options, "market", "init", ["--governance", "$governance"]),
    invokeCommand(options, "funding-settlement", "init", [
      "--governance",
      "$governance",
      "--proof_ledger",
      "$proof-ledger",
      "--market_contract",
      "$market",
      "--circuit_id",
      bytes32(circuitKey("funding-update")),
    ]),
    invokeCommand(options, "position-state", "init", [
      "--governance",
      "$governance",
      "--initial_root",
      bytes32(INITIAL_POSITION_ROOT),
    ]),
    invokeCommand(options, "batch-settlement", "init", [
      "--governance",
      "$governance",
      "--proof_ledger",
      "$proof-ledger",
      "--market_contract",
      "$market",
      "--position_state",
      "$position-state",
      "--intent_registry",
      "$intent-registry",
      "--circuit_id",
      bytes32(circuitKey("batch-match")),
    ]),
    invokeCommand(options, "liquidation", "init", [
      "--governance",
      "$governance",
      "--proof_ledger",
      "$proof-ledger",
      "--market_contract",
      "$market",
      "--position_state",
      "$position-state",
      "--circuit_id",
      bytes32(circuitKey("liquidation-check")),
    ]),
    invokeCommand(options, "conditional-order", "init", [
      "--governance",
      "$governance",
      "--proof_ledger",
      "$proof-ledger",
      "--market_contract",
      "$market",
      "--circuit_id",
      bytes32(circuitKey("conditional-close")),
    ]),
    invokeCommand(options, "position-close", "init", [
      "--governance",
      "$governance",
      "--proof_ledger",
      "$proof-ledger",
      "--conditional_order",
      "$conditional-order",
      "--market_contract",
      "$market",
      "--position_state",
      "$position-state",
      "--circuit_id",
      bytes32(circuitKey("position-close")),
    ]),
    invokeCommand(options, "position-state", "set_writer", [
      "--writer",
      "$batch-settlement",
      "--enabled",
      "true",
    ]),
    invokeCommand(options, "position-state", "set_writer", [
      "--writer",
      "$liquidation",
      "--enabled",
      "true",
    ]),
    invokeCommand(options, "position-state", "set_writer", [
      "--writer",
      "$position-close",
      "--enabled",
      "true",
    ]),
    invokeCommand(options, "market", "set_funding_updater", [
      "--updater",
      "$funding-settlement",
      "--enabled",
      "true",
    ]),
    invokeCommand(options, "disclosure-verifier", "init", [
      "--governance",
      "$governance",
      "--proof_ledger",
      "$proof-ledger",
      "--circuit_id",
      bytes32(circuitKey("disclosure")),
    ]),
  );

  if (options.smoke) {
    commands.push(...smokeCommands(options, root));
  }

  return commands;
}

export function deploy(options: Options, root = process.cwd()): Deployment {
  const contracts = new Map<string, string>();
  const verifiers = new Map<string, string>();

  if (options.build) {
    run(["bun", "run", "prove:circuits"], options);
    run(["bun", "run", "build:contracts"], options);
  }
  const manifest = createDeployManifest(root);
  if (options.setupLocal) {
    setupLocalNetwork(options);
  }

  const sourceAddress = resolveSourceAddress(options);
  for (const contract of deployableContracts(manifest)) {
    contracts.set(
      contract.name,
      deployWasm(options, contract.path, `${options.aliasPrefix}-${contract.name}`),
    );
  }
  for (const verifier of manifest.verifiers) {
    verifiers.set(
      verifier.verifierAuthority,
      deployWasm(options, proofVerifierPath(manifest), `${options.aliasPrefix}-${verifier.verifierAuthority}`),
    );
  }

  invoke(options, contracts.get("governance")!, "init", ["--admin", sourceAddress]);
  invoke(options, contracts.get("proof-ledger")!, "init", [
    "--governance",
    contracts.get("governance")!,
  ]);
  invoke(options, contracts.get("price-oracle")!, "init", [
    "--admin",
    sourceAddress,
    "--decimals",
    String(loadEnv().oraclePriceDecimals),
  ]);

  for (const verifier of manifest.verifiers) {
    const verifierId = verifiers.get(verifier.verifierAuthority)!;
    invoke(options, verifierId, "init", [
      "--governance",
      contracts.get("governance")!,
      "--proof_ledger",
      contracts.get("proof-ledger")!,
      "--circuit_id",
      bytes32(verifier.circuitKey),
      "--verifier_hash",
      bytes32(verifier.verifierHash),
      "--vk_bytes-file-path",
      verifier.vkPath,
    ]);
    invoke(options, contracts.get("governance")!, "set_verifier", [
      "--circuit_id",
      bytes32(verifier.circuitKey),
      "--verifier_hash",
      bytes32(verifier.verifierHash),
      "--authority",
      verifierId,
    ]);
  }

  initProofConsumers(options, contracts);
  if (options.smoke) runSmoke(options, root, verifiers);

  const deployment: Deployment = {
    contracts: Object.fromEntries(contracts),
    network: options.network,
    source: options.source,
    sourceAddress,
    verifiers: Object.fromEntries(verifiers),
  };
  if (options.out) writeJson(options.out, deployment);
  return deployment;
}

function initProofConsumers(options: Options, contracts: Map<string, string>): void {
  const governance = contracts.get("governance")!;
  const proofLedger = contracts.get("proof-ledger")!;
  const positionState = contracts.get("position-state")!;
  invoke(options, contracts.get("shielded-pool")!, "init", [
    "--governance",
    governance,
    "--proof_ledger",
    proofLedger,
    "--deposit_circuit_id",
    bytes32(circuitKey("deposit-note")),
    "--withdraw_circuit_id",
    bytes32(circuitKey("withdraw")),
  ]);
  invoke(options, contracts.get("market")!, "init", ["--governance", governance]);
  invoke(options, contracts.get("funding-settlement")!, "init", [
    "--governance",
    governance,
    "--proof_ledger",
    proofLedger,
    "--market_contract",
    contracts.get("market")!,
    "--circuit_id",
    bytes32(circuitKey("funding-update")),
  ]);
  invoke(options, positionState, "init", [
    "--governance",
    governance,
    "--initial_root",
    bytes32(INITIAL_POSITION_ROOT),
  ]);
  invoke(options, contracts.get("batch-settlement")!, "init", [
    "--governance",
    governance,
    "--proof_ledger",
    proofLedger,
    "--market_contract",
    contracts.get("market")!,
    "--position_state",
    positionState,
    "--intent_registry",
    contracts.get("intent-registry")!,
    "--circuit_id",
    bytes32(circuitKey("batch-match")),
  ]);
  invoke(options, contracts.get("liquidation")!, "init", [
    "--governance",
    governance,
    "--proof_ledger",
    proofLedger,
    "--market_contract",
    contracts.get("market")!,
    "--position_state",
    positionState,
    "--circuit_id",
    bytes32(circuitKey("liquidation-check")),
  ]);
  invoke(options, contracts.get("conditional-order")!, "init", [
    "--governance",
    governance,
    "--proof_ledger",
    proofLedger,
    "--market_contract",
    contracts.get("market")!,
    "--circuit_id",
    bytes32(circuitKey("conditional-close")),
  ]);
  invoke(options, contracts.get("position-close")!, "init", [
    "--governance",
    governance,
    "--proof_ledger",
    proofLedger,
    "--conditional_order",
    contracts.get("conditional-order")!,
    "--market_contract",
    contracts.get("market")!,
    "--position_state",
    positionState,
    "--circuit_id",
    bytes32(circuitKey("position-close")),
  ]);
  invoke(options, positionState, "set_writer", [
    "--writer",
    contracts.get("batch-settlement")!,
    "--enabled",
    "true",
  ]);
  invoke(options, positionState, "set_writer", [
    "--writer",
    contracts.get("liquidation")!,
    "--enabled",
    "true",
  ]);
  invoke(options, positionState, "set_writer", [
    "--writer",
    contracts.get("position-close")!,
    "--enabled",
    "true",
  ]);
  invoke(options, contracts.get("market")!, "set_funding_updater", [
    "--updater",
    contracts.get("funding-settlement")!,
    "--enabled",
    "true",
  ]);
  invoke(options, contracts.get("disclosure-verifier")!, "init", [
    "--governance",
    governance,
    "--proof_ledger",
    proofLedger,
    "--circuit_id",
    bytes32(circuitKey("disclosure")),
  ]);
}

function runSmoke(options: Options, root: string, verifiers: Map<string, string>): void {
  for (const command of smokeCommands(options, root, verifiers.get("withdraw-proof-verifier"))) {
    run(command, options);
  }
}

function smokeCommands(options: Options, root: string, verifierId = "$withdraw-proof-verifier"): string[][] {
  const dir = join(root, "circuits/withdraw/target/bb");
  const publicInputs = join(dir, "public_inputs");
  const proof = join(dir, "proof");

  return [
    invokeCommand(options, verifierId, "verify_and_record", [
      "--public_inputs-file-path",
      publicInputs,
      "--proof_bytes-file-path",
      proof,
      "--public_input_hash",
      fileHashArg(options, publicInputs, "withdraw-public-input-hash"),
      "--proof_digest",
      fileHashArg(options, proof, "withdraw-proof-digest"),
    ]),
  ];
}

function fileHashArg(options: Options, path: string, label: string): string {
  if (existsSync(path)) return bytes32(hashFile(path));
  if (options.dryRun) return `<${label}>`;
  return bytes32(hashFile(path));
}

function deployWasm(options: Options, wasm: string, alias: string): string {
  const output = runWithRetry(deployCommand(options, wasm, alias), options, 8, 8000);
  const id = output.match(/\bC[A-Z0-9]{55}\b/)?.[0];
  if (!id) throw new Error(`could not parse contract id for ${alias}`);
  paceNetwork(options);
  return id;
}

function deployCommand(options: Options, wasm: string, alias: string): string[] {
  return [
    "stellar",
    "contract",
    "deploy",
    "--wasm",
    wasm,
    "--source",
    options.source,
    "--network",
    options.network,
    ...networkArgs(),
    "--alias",
    alias,
    "--auto-sign",
  ];
}

function invoke(options: Options, id: string, method: string, args: string[]): string {
  const output = runWithRetry(invokeCommand(options, id, method, args), options, 4, 6000);
  paceNetwork(options);
  return output;
}

function invokeCommand(options: Options, id: string, method: string, args: string[]): string[] {
  return [
    "stellar",
    "contract",
    "invoke",
    "--id",
    id,
    "--source",
    options.source,
    "--network",
    options.network,
    ...networkArgs(),
    "--send",
    "yes",
    "--auto-sign",
    "--",
    method,
    ...args,
  ];
}

function networkArgs(): string[] {
  const env = loadEnv();
  return [
    ...(env.stellarRpcUrl ? ["--rpc-url", env.stellarRpcUrl] : []),
    ...(env.stellarNetworkPassphrase ? ["--network-passphrase", env.stellarNetworkPassphrase] : []),
  ];
}

function localSetupCommands(options: Options): string[][] {
  return [
    [
      "stellar",
      "container",
      "start",
      "local",
      "--name",
      options.network,
      "--limits",
      "unlimited",
      "--protocol-version",
      "26",
    ],
    [
      "stellar",
      "network",
      "add",
      options.network,
      "--rpc-url",
      LOCAL_RPC,
      "--network-passphrase",
      LOCAL_PASSPHRASE,
    ],
    ["stellar", "network", "use", options.network],
    ["stellar", "keys", "generate", options.source, "--network", options.network],
    ["stellar", "network", "health", "--network", options.network],
    ["stellar", "keys", "fund", options.source, "--network", options.network],
  ];
}

function setupLocalNetwork(options: Options): void {
  for (const command of localSetupCommands(options)) {
    if (isCommand(command, "stellar", "network", "health")) {
      runWithRetry(command, options, 24, 2500);
    } else if (isCommand(command, "stellar", "keys", "fund")) {
      runWithRetry(command, options, 24, 2500);
    } else {
      run(command, options, true);
    }
  }
}

function sourceAddressCommand(source: string): string[] {
  return ["stellar", "keys", "address", source];
}

function resolveSourceAddress(options: Options): string {
  if (/^G[A-Z0-9]{55}$/.test(options.source)) return options.source;
  const output = run(sourceAddressCommand(options.source), options);
  const address = output.match(/\bG[A-Z0-9]{55}\b/)?.[0];
  if (!address) throw new Error(`could not resolve source address for ${options.source}`);
  return address;
}

function run(command: string[], options: Options, allowFailure = false): string {
  if (options.dryRun) {
    console.log(command.map(quote).join(" "));
    return "";
  }
  const result = runRaw(command);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command.map(quote).join(" ")} failed\n${result.output}`);
  }
  if (result.output.trim()) console.log(result.output.trim());
  return result.output;
}

function runWithRetry(command: string[], options: Options, attempts: number, delayMs: number): string {
  if (options.dryRun) return run(command, options);

  let lastOutput = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runRaw(command);
    lastOutput = result.output;
    if (result.status === 0) {
      if (result.output.trim()) console.log(result.output.trim());
      return result.output;
    }
    if (attempt < attempts) sleep(delayMs);
  }

  throw new Error(`${command.map(quote).join(" ")} failed after ${attempts} attempts\n${lastOutput}`);
}

function runRaw(command: string[]): { output: string; status: number } {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return { output, status: result.status ?? 1 };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function paceNetwork(options: Options): void {
  if (!options.dryRun && options.network !== "local") sleep(3500);
}

function isCommand(command: string[], ...prefix: string[]): boolean {
  return prefix.every((part, index) => command[index] === part);
}

function proofVerifierPath(manifest: ReturnType<typeof createDeployManifest>): string {
  const contract = manifest.contracts.find((item) => item.name === "proof-verifier");
  if (!contract) throw new Error("missing proof-verifier contract artifact");
  return contract.path;
}

function deployableContracts(manifest: ReturnType<typeof createDeployManifest>) {
  return manifest.contracts.filter((contract) => contract.name !== "proof-verifier");
}

function hashFile(path: string): Hex {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`);
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `0x${hash}`;
}

function bytes32(hex: Hex | string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function optionalValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function value(argv: string[], name: string, fallback: string): string {
  return optionalValue(argv, name) ?? fallback;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value);
}

if (import.meta.main) {
  const options = parseOptions();
  if (options.dryRun) {
    commandPlan(options).forEach((command) => console.log(command.map(quote).join(" ")));
  } else {
    console.log(JSON.stringify(deploy(options), null, 2));
  }
}
