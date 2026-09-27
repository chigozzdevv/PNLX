import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { circuitKey, loadCircuit } from "@pnlx/proof-system";

type Registry = {
  contracts: Record<string, string>;
  network: string;
  sourceAddress: string;
  upgradeAuthority: string;
  verifiers: Record<string, string>;
  wasmHashes: Record<string, string>;
};

const root = process.cwd();
const registryPath = resolve(root, "deployments/testnet.json");
const checkpointPath = `${registryPath}.secure-notes.partial`;
const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
const execute = process.argv.includes("--execute");
const admin = "pnlx-testnet";
const authority = "pnlx-upgrade";
const pool = registry.contracts["shielded-pool"];
const governance = registry.contracts.governance;
const proofLedger = registry.contracts["proof-ledger"];
const contractNames = ["shielded-pool", "intent-registry", "batch-settlement", "position-close"] as const;
const circuitNames = ["intent-validity", "position-close", "secure-deposit-note", "secure-withdraw"] as const;
const filenames: Record<(typeof contractNames)[number], string> = {
  "shielded-pool": "shielded_pool.wasm",
  "intent-registry": "intent_registry.wasm",
  "batch-settlement": "batch_settlement.wasm",
  "position-close": "position_close.wasm",
};

if (registry.network !== "testnet" || !pool || !governance || !proofLedger ||
  registry.sourceAddress !== keyAddress(admin) || registry.upgradeAuthority !== keyAddress(authority)) {
  throw new Error("Testnet deployment or signer mismatch");
}

const artifacts = contractNames.map((name) => resolve(root, "contracts/target/stellar", filenames[name]));
artifacts.push(resolve(root, "contracts/target/stellar/proof_verifier.wasm"));
for (const id of circuitNames) {
  const circuit = loadCircuit(root, id);
  const vk = resolve(root, circuit.dir, "target/bb/vk");
  requireFile(vk);
  if (createHash("sha256").update(readFileSync(vk)).digest("hex") !== bytes32(circuit.verifierHash)) {
    throw new Error(`${id} verification key does not match its circuit manifest`);
  }
  artifacts.push(vk);
}
for (const path of artifacts) requireFile(path);
for (const name of contractNames) {
  if (!/^C[A-Z2-7]{55}$/.test(registry.contracts[name] ?? "")) {
    throw new Error(`missing ${name} contract`);
  }
}
const artifactFingerprint = createHash("sha256")
  .update(JSON.stringify({ contracts: registry.contracts, sourceAddress: registry.sourceAddress,
    upgradeAuthority: registry.upgradeAuthority }))
  .update(artifacts.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex")).join(":"))
  .digest("hex");

const checkpoint = existsSync(checkpointPath)
  ? JSON.parse(readFileSync(checkpointPath, "utf8")) as Record<string, string>
  : {};
if (checkpoint.fingerprint && checkpoint.fingerprint !== artifactFingerprint) {
  throw new Error("upgrade artifacts or deployment changed since the partial run");
}
if (execute && !checkpoint.fingerprint) {
  checkpoint.fingerprint = artifactFingerprint;
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}
const operations: string[][] = [];
function step(key: string, command: string[]): string {
  if (checkpoint[key]) return checkpoint[key];
  operations.push(command);
  if (!execute) return `<${key}>`;
  const output = run(command);
  checkpoint[key] = output || "done";
  writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  return output;
}

for (const name of contractNames) {
  const wasm = resolve(root, "contracts/target/stellar", filenames[name]);
  requireFile(wasm);
  const hash = bytes32(step(`upload:${name}`, ["stellar", "contract", "upload", "--wasm", wasm,
    "--source", admin, "--network", "testnet", "--optimize=false"]));
  step(`upgrade:${name}`, invoke(registry.contracts[name], authority, "upgrade",
    ["--new_wasm_hash", hash]));
}

for (const id of ["intent-validity", "position-close"] as const) {
  const verifier = registry.verifiers[`${id}-proof-verifier`];
  if (!verifier) throw new Error(`missing ${id} verifier`);
  const circuit = loadCircuit(root, id);
  const vk = resolve(root, circuit.dir, "target/bb/vk");
  requireFile(vk);
  step(`rotate:${id}`, invoke(verifier, authority, "rotate_vk", [
    "--verifier_hash", bytes32(circuit.verifierHash), "--vk_bytes-file-path", vk,
  ]));
  step(`governance:${id}`, invoke(governance, admin, "set_verifier", [
    "--circuit_id", bytes32(circuitKey(id)), "--verifier_hash", bytes32(circuit.verifierHash),
    "--authority", verifier,
  ]));
}

for (const id of ["secure-deposit-note", "secure-withdraw"] as const) {
  const circuit = loadCircuit(root, id);
  const vk = resolve(root, circuit.dir, "target/bb/vk");
  const wasm = resolve(root, "contracts/target/stellar/proof_verifier.wasm");
  requireFile(vk);
  requireFile(wasm);
  const verifier = step(`deploy:${id}`, ["stellar", "contract", "deploy", "--wasm", wasm,
    "--source", admin, "--network", "testnet", "--auto-sign"]);
  step(`init:${id}`, invoke(verifier, admin, "init", [
    "--governance", governance, "--proof_ledger", proofLedger,
    "--circuit_id", bytes32(circuitKey(id)), "--verifier_hash", bytes32(circuit.verifierHash),
    "--vk_bytes-file-path", vk,
  ]));
  step(`governance:${id}`, invoke(governance, admin, "set_verifier", [
    "--circuit_id", bytes32(circuitKey(id)), "--verifier_hash", bytes32(circuit.verifierHash),
    "--authority", verifier,
  ]));
}

step("configure:tree", invoke(pool, admin, "configure_secure_note_circuits", [
  "--deposit_circuit_id", bytes32(circuitKey("secure-deposit-note")),
  "--withdraw_circuit_id", bytes32(circuitKey("secure-withdraw")),
]));
step("configure:writer", invoke(pool, admin, "set_writer", [
  "--writer", registry.contracts["position-close"], "--enabled", "true",
]));
step("activate:pool", invoke(pool, admin, "disable_legacy_notes"));
step("configure:registry", invoke(registry.contracts["intent-registry"], admin,
  "configure_secure_pool", ["--pool", pool]));
step("configure:close", invoke(registry.contracts["position-close"], admin,
  "configure_secure_pool", ["--pool", pool]));

if (!execute) {
  process.stdout.write(`${operations.map((command) => command.join(" ")).join("\n")}\n`);
} else {
  if (JSON.parse(run(invoke(pool, admin, "legacy_notes_disabled", [], false))) !== true ||
    Number(JSON.parse(run(invoke(pool, admin, "secure_note_count", [], false)))) !== 0) {
    throw new Error("secure pool verification failed");
  }
  for (const name of contractNames) {
    const wasm = resolve(root, "contracts/target/stellar", filenames[name]);
    registry.wasmHashes[name] = `0x${createHash("sha256").update(readFileSync(wasm)).digest("hex")}`;
  }
  for (const id of ["secure-deposit-note", "secure-withdraw"] as const) {
    registry.verifiers[`${id}-proof-verifier`] = checkpoint[`deploy:${id}`];
  }
  const temporary = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(temporary, registryPath);
  unlinkSync(checkpointPath);
  process.stdout.write(`${JSON.stringify({ active: true, pool, secureNoteCount: 0 })}\n`);
}

function invoke(contract: string, source: string, method: string, args: string[] = [], send = true): string[] {
  if (!/^C[A-Z2-7]{55}$/.test(contract) && !(contract.startsWith("<deploy:") && !execute)) {
    throw new Error(`invalid contract for ${method}`);
  }
  return ["stellar", "contract", "invoke", "--id", contract, "--source", source,
    "--network", "testnet", "--send", send ? "yes" : "no", "--", method, ...args];
}

function keyAddress(alias: string): string {
  return run(["stellar", "keys", "address", alias]).match(/\bG[A-Z2-7]{55}\b/)?.[0] ?? "";
}

function bytes32(value: string): string {
  const hash = value.replace(/^0x/, "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hash) && !hash.startsWith("<")) throw new Error("invalid hash");
  return hash;
}

function requireFile(path: string): void {
  if (!existsSync(path)) throw new Error(`missing build artifact: ${path}`);
}

function run(command: string[]): string {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim().match(/(C[A-Z2-7]{55}|[0-9a-fA-F]{64}|true|false|[0-9]+)\s*$/)?.[1] ?? result.stdout.trim();
}
