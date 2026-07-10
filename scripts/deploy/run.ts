import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { circuitKey } from "@pnlx/proof-system";
import type { Hex } from "@pnlx/protocol-types";
import { loadEnv } from "@/config/env";
import {
  RISC0_BATCH_MATCH_CIRCUIT_KEY,
  RISC0_BATCH_MATCH_IMAGE_ID,
} from "@/workers/risc0-matcher/risc0-proof";
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
  risc0VerifierStack: Risc0VerifierStackDeployment;
  risc0BatchMatchImageId: Hex;
  source: string;
  sourceAddress: string;
  verifiers: Record<string, string>;
}

interface Risc0VerifierStackDeployment {
  emergencyStop: string;
  groth16Verifier: string;
  owner: string;
  router: string;
  selector: string;
}

const LOCAL_PASSPHRASE = "Standalone Network ; February 2017";
const LOCAL_RPC = "http://localhost:8000/soroban/rpc";

export function parseOptions(argv = process.argv.slice(2)): Options {
  return {
    aliasPrefix: value(argv, "--alias-prefix", "pnlx"),
    build: flag(argv, "--build"),
    dryRun: flag(argv, "--dry-run"),
    network: value(argv, "--network", "local"),
    out: optionalValue(argv, "--out"),
    setupLocal: flag(argv, "--setup-local"),
    smoke: !flag(argv, "--no-smoke"),
    source: value(argv, "--source", "pnlx-admin"),
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
    commands.push(["bun", "run", "build:risc0-verifier-stack"]);
  }
  if (options.setupLocal) {
    commands.push(...localSetupCommands(options));
  }
  commands.push(sourceAddress);
  commands.push(...risc0VerifierStackCommandPlan(options, manifest));
  for (const contract of deployableContracts(manifest)) {
    commands.push(deployCommand(options, contract.path, `${options.aliasPrefix}-${contract.name}`));
  }
  for (const verifier of manifest.verifiers) {
    commands.push(
      deployCommand(
        options,
        verifierContractPath(manifest, verifier.verifierContract),
        `${options.aliasPrefix}-${verifier.verifierAuthority}`,
      ),
    );
  }

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
    const initArgs = verifierInitArgs(verifier, env, {
      governance: "$governance",
      proofLedger: "$proof-ledger",
      router: "$risc0-router",
    });
    commands.push(
      invokeCommand(options, verifier.verifierAuthority, "init", initArgs),
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
      "--shielded_pool",
      "$shielded-pool",
      "--intent_registry",
      "$intent-registry",
      "--circuit_id",
      bytes32(RISC0_BATCH_MATCH_CIRCUIT_KEY),
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
    invokeCommand(options, "shielded-pool", "set_writer", [
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
    run(["bun", "run", "build:risc0-verifier-stack"], options);
  }
  const manifest = createDeployManifest(root);
  if (options.setupLocal) {
    setupLocalNetwork(options);
  }

  const env = loadEnv();
  const sourceAddress = resolveSourceAddress(options);
  const risc0VerifierStack = deployRisc0VerifierStack(options, manifest, sourceAddress);
  contracts.set("risc0-router", risc0VerifierStack.router);
  contracts.set("risc0-groth16-verifier", risc0VerifierStack.groth16Verifier);
  contracts.set("risc0-emergency-stop", risc0VerifierStack.emergencyStop);
  for (const contract of deployableContracts(manifest)) {
    contracts.set(
      contract.name,
      deployWasm(options, contract.path, `${options.aliasPrefix}-${contract.name}`),
    );
  }
  for (const verifier of manifest.verifiers) {
    verifiers.set(
      verifier.verifierAuthority,
      deployWasm(
        options,
        verifierContractPath(manifest, verifier.verifierContract),
        `${options.aliasPrefix}-${verifier.verifierAuthority}`,
      ),
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
    String(env.oraclePriceDecimals),
  ]);

  for (const verifier of manifest.verifiers) {
    const verifierId = verifiers.get(verifier.verifierAuthority)!;
    invoke(
      options,
      verifierId,
      "init",
      verifierInitArgs(verifier, env, {
        governance: contracts.get("governance")!,
        proofLedger: contracts.get("proof-ledger")!,
        router: risc0VerifierStack.router,
      }),
    );
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
    risc0VerifierStack,
    risc0BatchMatchImageId: RISC0_BATCH_MATCH_IMAGE_ID,
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
    "--shielded_pool",
    contracts.get("shielded-pool")!,
    "--intent_registry",
    contracts.get("intent-registry")!,
    "--circuit_id",
    bytes32(RISC0_BATCH_MATCH_CIRCUIT_KEY),
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
  invoke(options, contracts.get("shielded-pool")!, "set_writer", [
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

function risc0VerifierStackCommandPlan(
  options: Options,
  manifest: ReturnType<typeof createDeployManifest>,
): string[][] {
  const groth16 = risc0StackContractPath(manifest, "risc0-groth16-verifier");
  const emergencyStop = risc0StackContractPath(manifest, "risc0-emergency-stop");
  const router = risc0StackContractPath(manifest, "risc0-router");

  return [
    deployCommand(options, groth16, `${options.aliasPrefix}-risc0-groth16-verifier`),
    readCommand(options, "risc0-groth16-verifier", "selector", []),
    deployCommand(options, emergencyStop, `${options.aliasPrefix}-risc0-emergency-stop`, [
      "--verifier",
      "$risc0-groth16-verifier",
      "--owner",
      "$sourceAddress",
    ]),
    deployCommand(options, router, `${options.aliasPrefix}-risc0-router`, [
      "--owner",
      "$sourceAddress",
    ]),
    invokeCommand(options, "risc0-router", "add_verifier", [
      "--selector",
      "$risc0Selector",
      "--verifier",
      "$risc0-emergency-stop",
    ]),
  ];
}

function deployRisc0VerifierStack(
  options: Options,
  manifest: ReturnType<typeof createDeployManifest>,
  sourceAddress: string,
): Risc0VerifierStackDeployment {
  const groth16Verifier = deployWasm(
    options,
    risc0StackContractPath(manifest, "risc0-groth16-verifier"),
    `${options.aliasPrefix}-risc0-groth16-verifier`,
  );
  const selector = normalizeSelector(read(options, groth16Verifier, "selector", []));
  const emergencyStop = deployWasm(
    options,
    risc0StackContractPath(manifest, "risc0-emergency-stop"),
    `${options.aliasPrefix}-risc0-emergency-stop`,
    [
      "--verifier",
      groth16Verifier,
      "--owner",
      sourceAddress,
    ],
  );
  const router = deployWasm(
    options,
    risc0StackContractPath(manifest, "risc0-router"),
    `${options.aliasPrefix}-risc0-router`,
    [
      "--owner",
      sourceAddress,
    ],
  );
  invoke(options, router, "add_verifier", [
    "--selector",
    selector,
    "--verifier",
    emergencyStop,
  ]);

  return {
    emergencyStop,
    groth16Verifier,
    owner: sourceAddress,
    router,
    selector,
  };
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

function deployWasm(options: Options, wasm: string, alias: string, constructorArgs: string[] = []): string {
  const output = runWithRetry(deployCommand(options, wasm, alias, constructorArgs), options, 8, 8000);
  const id = output.match(/\bC[A-Z0-9]{55}\b/)?.[0];
  if (!id) throw new Error(`could not parse contract id for ${alias}`);
  paceNetwork(options);
  return id;
}

function deployCommand(options: Options, wasm: string, alias: string, constructorArgs: string[] = []): string[] {
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
    ...(constructorArgs.length ? ["--", ...constructorArgs] : []),
  ];
}

function invoke(options: Options, id: string, method: string, args: string[]): string {
  const output = runWithRetry(invokeCommand(options, id, method, args), options, 4, 6000);
  paceNetwork(options);
  return output;
}

function read(options: Options, id: string, method: string, args: string[]): string {
  return runWithRetry(readCommand(options, id, method, args), options, 4, 6000);
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

function readCommand(options: Options, id: string, method: string, args: string[]): string[] {
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
    "no",
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

function verifierContractPath(manifest: ReturnType<typeof createDeployManifest>, contractName: string): string {
  const contract = manifest.contracts.find((item) => item.name === contractName);
  if (!contract) throw new Error(`missing ${contractName} contract artifact`);
  return contract.path;
}

function risc0StackContractPath(
  manifest: ReturnType<typeof createDeployManifest>,
  contractName: string,
): string {
  const contract = manifest.risc0VerifierStack.find((item) => item.name === contractName);
  if (!contract) throw new Error(`missing ${contractName} RISC0 verifier stack artifact`);
  return contract.path;
}

function deployableContracts(manifest: ReturnType<typeof createDeployManifest>) {
  return manifest.contracts.filter((contract) =>
    contract.name !== "proof-verifier" && contract.name !== "risc0-proof-verifier"
  );
}

function verifierInitArgs(
  verifier: ReturnType<typeof createDeployManifest>["verifiers"][number],
  env: ReturnType<typeof loadEnv>,
  ids: { governance: string; proofLedger: string; router: string },
): string[] {
  const base = [
    "--governance",
    ids.governance,
    "--proof_ledger",
    ids.proofLedger,
  ];

  if (verifier.verifierContract === "risc0-proof-verifier") {
    const router = ids.router;
    if (!router) throw new Error("RISC0 router deployment is required for RISC0 verifier deployment");
    if (!verifier.imageId) throw new Error("RISC0 image id is required for RISC0 verifier deployment");
    return [
      ...base,
      "--router",
      router,
      "--circuit_id",
      bytes32(verifier.circuitKey),
      "--image_id",
      bytes32(verifier.imageId),
      "--verifier_hash",
      bytes32(verifier.verifierHash),
    ];
  }

  return [
    ...base,
    "--circuit_id",
    bytes32(verifier.circuitKey),
    "--verifier_hash",
    bytes32(verifier.verifierHash),
    "--vk_bytes-file-path",
    verifier.vkPath,
  ];
}

function normalizeSelector(output: string): string {
  const selector = output.trim().split(/\r?\n/).at(-1)?.replace(/^"|"$/g, "") ?? "";
  if (!/^[0-9a-fA-F]{8}$/.test(selector)) {
    throw new Error(`could not parse RISC0 Groth16 verifier selector from output: ${output}`);
  }
  return selector.toLowerCase();
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
