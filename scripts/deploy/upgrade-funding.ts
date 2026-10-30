import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { circuitKey, loadCircuit } from "@pnlx/proof-system";
import { hashFields } from "@pnlx/crypto";
import { RISC0_BATCH_MATCH_CIRCUIT_KEY, risc0VerifierIdentity } from "@/workers/risc0-matcher/risc0-proof";
import type { Hex } from "@pnlx/protocol-types";

type Artifact = { path: string; sha256: string };
export interface FundingUpgradeEvidence {
  version: 1;
  network: "testnet";
  lockedBuild: true;
  old: { fundingWasmHash: string; batchWasmHash: string; fundingVerifierWasmHash: string; fundingVerifierHash: string; batchImageId: string; batchVerifierHash: string };
  artifacts: Record<"fundingWasm" | "batchWasm" | "fundingVerifierWasm" | "fundingVk" | "fundingBytecode" | "guestProgram" | "guestHost" | "guestSeal" | "guestJournal", Artifact>;
  sourceHashes: { contracts: string; fundingCircuit: string; guest: string };
  guest: { imageId: string; computedImageId: string; developmentMode: false; productionReceiptVerified: true };
  collateralToken: string;
  marketId: string;
}
export interface FundingUpgradeRegistry {
  network: string; source: string; sourceAddress: string; upgradeAuthority: string;
  contracts: Record<string, string>; verifiers: Record<string, string>; wasmHashes: Record<string, string>;
  risc0BatchMatchImageId: string; risc0BatchMatchVerifierHash?: string;
  [key: string]: unknown;
}
type Command = { argv: string[]; env?: Record<string, string> };
type Guard = { id: string; command: Command; expected: string; old?: string; binary?: boolean };
type Step = { id: string; command: Command; guards: Guard[]; transitionGuards?: Guard[] };
export interface FundingUpgradePlan {
  version: 1; identityHash: string; fingerprint: string;
  registry: FundingUpgradeRegistry; evidence: FundingUpgradeEvidence;
  steps: Step[]; invariants: Guard[]; initialGuards: Guard[]; finalGuards: Guard[]; preflights: Guard[];
}
export interface FundingDrainSnapshot {
  version: 1; network: string; identityHash: string; capturedAt: number;
  workersStopped: { batch: boolean; funding: boolean; liquidation: boolean; protection: boolean; makers: boolean };
  pending: { batch: number; funding: number; proofs: number; closes: number; intents: number };
}
export interface FundingUpgradeCheckpoint {
  fingerprint: string;
  baseline: Record<string, string>;
  steps: Record<string, "attempted" | "verified">;
}
export interface UpgradeRunner {
  run(command: Command): { status: number | null; stdout: string | Uint8Array; stderr?: string };
  drain(): FundingDrainSnapshot;
  save(checkpoint: FundingUpgradeCheckpoint): void;
  now?: () => number;
}

/** Reads artifacts only. No signer lookup, RPC, mutation, or transaction runs here. */
export function createFundingUpgradePlan(
  registry: FundingUpgradeRegistry, evidence: FundingUpgradeEvidence,
  options: { root?: string; adminSource?: string; upgradeSource?: string } = {},
): FundingUpgradePlan {
  const root = options.root ?? process.cwd();
  if (registry.network !== "testnet" || evidence.network !== registry.network || evidence.version !== 1 || evidence.lockedBuild !== true) {
    throw new Error("a locked Testnet build and deployment are required");
  }
  const contracts = registry.contracts, verifiers = registry.verifiers;
  for (const id of [contracts.governance, contracts["funding-settlement"], contracts["batch-settlement"], contracts["position-state"],
    contracts["shielded-pool"], contracts.market, contracts["risc0-router"], verifiers["funding-update-proof-verifier"],
    verifiers["batch-match-risc0-verifier"], evidence.collateralToken]) address(id, "C");
  address(registry.sourceAddress, "G"); address(registry.upgradeAuthority, "G");
  if (!evidence.marketId?.trim()) throw new Error("the verified funding market is required");
  const artifacts = evidence.artifacts;
  for (const artifact of Object.values(artifacts)) {
    hash32(artifact.sha256);
    const file = resolve(root, artifact.path);
    if (!existsSync(file) || fileHash(file) !== artifact.sha256.toLowerCase()) throw new Error(`artifact differs from evidence: ${artifact.path}`);
  }
  for (const key of ["fundingWasm", "batchWasm", "fundingVerifierWasm"] as const) {
    if (!readFileSync(resolve(root, artifacts[key].path)).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error("invalid contract WASM");
  }
  if (!artifacts.guestProgram) throw new Error("the RISC0 ProgramBinary artifact is required");
  assertRisc0ProgramBinary(readFileSync(resolve(root, artifacts.guestProgram.path)));
  if (evidence.sourceHashes.contracts !== fundingUpgradeTreeHash(join(root, "contracts")) ||
      evidence.sourceHashes.guest !== fundingUpgradeTreeHash(join(root, "risc0/batch-match"))) throw new Error("build source fingerprint changed");
  const funding = loadCircuit(root, "funding-update");
  if (funding.verifierSource !== "artifact" || funding.verifierHash !== artifacts.fundingVk.sha256 ||
      funding.sourceHash !== evidence.sourceHashes.fundingCircuit ||
      resolve(root, artifacts.fundingVk.path) !== resolve(root, funding.dir, "target/bb/vk") ||
      resolve(root, artifacts.fundingBytecode.path) !== resolve(root, funding.dir, "target", `${funding.packageName}.json`)) {
    throw new Error("funding source, compiled bytecode, or verification key is not pinned");
  }
  const image = hash32(evidence.guest.imageId);
  const pin = JSON.parse(readFileSync(join(root, "risc0/batch-match/image-id.json"), "utf8")) as { imageId: string };
  if (image !== hash32(pin.imageId) || image !== hash32(evidence.guest.computedImageId) ||
      evidence.guest.developmentMode !== false || evidence.guest.productionReceiptVerified !== true) throw new Error("a verified production guest pin is required");
  const parametersHash = fileHash(join(root, "vendor/stellar-risc0-verifier/contracts/groth16-verifier/parameters.json"));
  const namespace = risc0VerifierIdentity(parametersHash as Hex, image as Hex);
  for (const value of Object.values(evidence.old)) hash32(value);
  if (image === evidence.old.batchImageId || namespace === evidence.old.batchVerifierHash || artifacts.fundingVk.sha256 === evidence.old.fundingVerifierHash) {
    throw new Error("new guest and funding public inputs require fresh verifier namespaces");
  }
  const identityHash = digest({ network: registry.network, contracts, verifiers, sourceAddress: registry.sourceAddress, upgradeAuthority: registry.upgradeAuthority });
  const admin = options.adminSource ?? registry.source, upgrade = options.upgradeSource ?? "pnlx-upgrade";
  if (!admin || !upgrade) throw new Error("both signer aliases are required");
  const invoke = (id: string, source: string, method: string, args: string[] = [], send = false): Command => ({ argv: [
    "stellar", "contract", "invoke", "--id", id, "--network", registry.network, "--source", source, "--send", send ? "yes" : "no", "--", method, ...args,
  ] });
  const read = (id: string, contract: string, method: string, expected: string, old?: string, args: string[] = []): Guard =>
    ({ id, command: invoke(contract, admin, method, args), expected, ...(old === undefined ? {} : { old }) });
  const wasmGuard = (name: string, expected: string, old?: string, contract = contracts[name]): Guard => ({ id: `wasm:${name}`,
    command: { argv: ["stellar", "contract", "info", "hash", "--id", contract, "--network", registry.network] }, expected, old });
  const fundingVerifier = verifiers["funding-update-proof-verifier"], batchVerifier = verifiers["batch-match-risc0-verifier"];
  const fundingKey = bare(circuitKey("funding-update")), batchKey = bare(RISC0_BATCH_MATCH_CIRCUIT_KEY);
  const governanceGuard = (id: string, key: string, expected: string, old: string): Guard =>
    read(`governance:${id}`, contracts.governance, "verifier", expected, old, ["--circuit_id", key]);
  const steps: Step[] = [];
  for (const [name, contract, artifact, oldHash, markers] of [
    ["funding-settlement", contracts["funding-settlement"], artifacts.fundingWasm, evidence.old.fundingWasmHash, ["requires_operator_auth", "funding_cycle_bound"]],
    ["batch-settlement", contracts["batch-settlement"], artifacts.batchWasm, evidence.old.batchWasmHash, ["funding_epoch_bound"]],
    ["funding-update-proof-verifier", fundingVerifier, artifacts.fundingVerifierWasm, evidence.old.fundingVerifierWasmHash, []],
  ] as const) {
    if (![oldHash, artifact.sha256].includes(registry.wasmHashes[name])) throw new Error(`registry ${name} code identity differs from evidence`);
    steps.push({ id: `upload:${name}`, command: { argv: ["stellar", "contract", "upload", "--wasm", resolve(root, artifact.path),
      "--source", admin, "--network", registry.network, "--optimize=false"] }, guards: [{ id: `code:${name}`,
      command: { argv: ["stellar", "contract", "fetch", "--wasm-hash", bare(artifact.sha256), "--network", registry.network] },
      binary: true, expected: artifact.sha256, old: "absent" }] });
    steps.push({ id: `upgrade:${name}`, command: invoke(contract, upgrade, "upgrade", ["--new_wasm_hash", bare(artifact.sha256)], true),
      guards: [wasmGuard(name, artifact.sha256, oldHash, contract), ...markers.map((marker) => read(`marker:${marker}`, contract, marker, "true"))],
      ...(name !== "funding-update-proof-verifier" ? {} : { transitionGuards: [
        read("preserve:funding-vk", fundingVerifier, "vk_hash", evidence.old.fundingVerifierHash),
        read("preserve:funding-namespace", fundingVerifier, "verifier_hash", evidence.old.fundingVerifierHash),
        read("preserve:funding-governance", fundingVerifier, "governance", contracts.governance),
        read("preserve:funding-ledger", fundingVerifier, "proof_ledger", contracts["proof-ledger"]),
        read("preserve:funding-circuit", fundingVerifier, "circuit_id", `0x${fundingKey}`),
      ] }),
    });
  }
  steps.push({ id: "rotate:funding-vk", command: invoke(fundingVerifier, upgrade, "rotate_vk", [
    "--verifier_hash", bare(artifacts.fundingVk.sha256), "--vk_bytes-file-path", resolve(root, artifacts.fundingVk.path)], true), guards: [
    read("funding:vk", fundingVerifier, "vk_hash", artifacts.fundingVk.sha256, evidence.old.fundingVerifierHash),
    read("funding:verifier", fundingVerifier, "verifier_hash", artifacts.fundingVk.sha256, evidence.old.fundingVerifierHash),
  ] });
  steps.push({ id: "bind:funding-vk", command: invoke(contracts.governance, admin, "set_verifier", [
    "--circuit_id", fundingKey, "--verifier_hash", bare(artifacts.fundingVk.sha256), "--authority", fundingVerifier], true),
    guards: [governanceGuard("funding", fundingKey, artifacts.fundingVk.sha256, evidence.old.fundingVerifierHash)] });
  steps.push({ id: "rotate:batch-image", command: invoke(batchVerifier, upgrade, "set_image_id", [
    "--image_id", bare(image), "--verifier_hash", bare(namespace)], true), guards: [
    read("batch:image", batchVerifier, "image_id", image, evidence.old.batchImageId),
    read("batch:verifier", batchVerifier, "verifier_hash", namespace, evidence.old.batchVerifierHash),
  ] });
  steps.push({ id: "bind:batch-image", command: invoke(contracts.governance, admin, "set_verifier", [
    "--circuit_id", batchKey, "--verifier_hash", bare(namespace), "--authority", batchVerifier], true),
    guards: [governanceGuard("batch", batchKey, namespace, evidence.old.batchVerifierHash)] });
  const initialGuards = [
    { id: "signer:admin", command: { argv: ["stellar", "keys", "address", admin] }, expected: registry.sourceAddress },
    { id: "signer:upgrade", command: { argv: ["stellar", "keys", "address", upgrade] }, expected: registry.upgradeAuthority },
    read("authority:admin", contracts.governance, "admin", registry.sourceAddress),
    read("authority:upgrade", contracts.governance, "upgrade_authority", registry.upgradeAuthority),
    ...[["funding", fundingKey, fundingVerifier], ["batch", batchKey, batchVerifier]].map(([id, key, verifier]) =>
      read(`authority:${id}`, contracts.governance, "verifier_authority", verifier, undefined, ["--circuit_id", key])),
    read("router:identity", batchVerifier, "router", contracts["risc0-router"]),
    read("circuit:funding", fundingVerifier, "circuit_id", `0x${fundingKey}`),
    read("circuit:batch", batchVerifier, "circuit_id", `0x${batchKey}`),
    ...[fundingVerifier, batchVerifier].flatMap((verifier, index) => [
      read(`verifier-governance:${index}`, verifier, "governance", contracts.governance),
      read(`verifier-ledger:${index}`, verifier, "proof_ledger", contracts["proof-ledger"]),
    ]),
  ];
  const invariants = [
    read("state:positions", contracts["position-state"], "current_root", ""),
    read("state:position-count", contracts["position-state"], "leaf_count", ""),
    read("state:notes", contracts["shielded-pool"], "secure_note_root", ""),
    read("state:note-count", contracts["shielded-pool"], "secure_note_count", ""),
    read("state:pool-balance", evidence.collateralToken, "balance", "", undefined, ["--id", contracts["shielded-pool"]]),
    read("state:funding-index", contracts.market, "funding_index", "", undefined, ["--market_id", bare(hashFields("market-id", [evidence.marketId]))]),
  ];
  const preflights: Guard[] = [{ id: "guest:computed-image", command: { argv: [resolve(root, artifacts.guestHost.path), "--print-image-id"],
    env: { RISC0_BATCH_MATCH_PROGRAM_PATH: resolve(root, artifacts.guestProgram.path), RISC0_DEV_MODE: "0" } }, expected: image },
  { id: "guest:production-receipt", command: invoke(contracts["risc0-router"], admin, "verify", [
    "--seal-file-path", resolve(root, artifacts.guestSeal.path), "--image_id", bare(image), "--journal", bare(artifacts.guestJournal.sha256)], false), expected: "null" }];
  const finalGuards = [...initialGuards, ...steps.flatMap((step) => step.guards)];
  const fingerprint = digest({ identityHash, evidence, steps, invariants, preflights });
  return { version: 1, registry, evidence, identityHash, fingerprint, steps, invariants, initialGuards, finalGuards, preflights };
}

/** All financial state is read only. This function performs only the reviewed upgrade operations. */
export function executeFundingUpgrade(plan: FundingUpgradePlan, runner: UpgradeRunner, previous?: FundingUpgradeCheckpoint): FundingUpgradeCheckpoint {
  if (previous && previous.fingerprint !== plan.fingerprint) throw new Error("upgrade checkpoint fingerprint differs");
  if (previous && (plan.invariants.some((guard) => typeof previous.baseline?.[guard.id] !== "string" || !previous.baseline[guard.id]) ||
      Object.entries(previous.steps ?? {}).some(([id, status]) => !plan.steps.some((step) => step.id === id) || !["attempted", "verified"].includes(status)))) {
    throw new Error("upgrade checkpoint is incomplete or malformed");
  }
  const checkpoint = previous ?? { fingerprint: plan.fingerprint, baseline: {}, steps: {} };
  const now = runner.now ?? Date.now;
  const read = (guard: Guard): string => {
    const result = runner.run(guard.command);
    if (result.status !== 0) {
      if (guard.binary && /(?:not found|notfound|missing contract code)/i.test(result.stderr ?? "")) return "absent";
      throw new Error(`read failed: ${guard.id}`);
    }
    return guard.binary ? digestBytes(result.stdout) : normalize(result.stdout);
  };
  const exact = (guards: Guard[]) => { for (const guard of guards) if (read(guard) !== guard.expected) throw new Error(`live guard mismatch: ${guard.id}`); };
  const checkDrain = () => {
    const drain = runner.drain();
    if (drain.version !== 1 || drain.network !== plan.registry.network || drain.identityHash !== plan.identityHash ||
      !Number.isSafeInteger(drain.capturedAt) || now() - drain.capturedAt > 300_000 || drain.capturedAt > now() ||
      ["batch", "funding", "liquidation", "protection", "makers"].some((id) => drain.workersStopped?.[id as keyof typeof drain.workersStopped] !== true) ||
      ["batch", "funding", "proofs", "closes", "intents"].some((id) => drain.pending?.[id as keyof typeof drain.pending] !== 0)) {
      throw new Error("fresh drained-worker evidence with zero pending attempts is required");
    }
  };
  const stable = () => {
    for (const guard of plan.invariants) {
      const value = read(guard);
      if (!(guard.id in checkpoint.baseline)) checkpoint.baseline[guard.id] = value;
      else if (checkpoint.baseline[guard.id] !== value) throw new Error(`financial state changed: ${guard.id}`);
    }
  };
  checkDrain(); exact(plan.initialGuards); exact(plan.preflights); stable(); runner.save(checkpoint);
  // Every existing binding must be an exact reviewed old or target value, even before uploads.
  for (const step of plan.steps) for (const guard of step.guards.filter((guard) => guard.old !== undefined)) {
    const value = read(guard);
    if (value !== guard.expected && value !== guard.old) throw new Error(`unrecognized live identity: ${guard.id}`);
  }
  for (const step of plan.steps) {
    checkDrain(); stable(); exact(plan.initialGuards);
    const primary = step.guards[0];
    const value = read(primary);
    if (value === primary.expected) {
      exact(step.guards); checkpoint.steps[step.id] = "verified"; runner.save(checkpoint); continue;
    }
    if (checkpoint.steps[step.id]) throw new Error(`unresolved or changed checkpoint: ${step.id}; reconcile before retrying`);
    if (value !== primary.old) throw new Error(`unrecognized live identity: ${primary.id}`);
    exact(step.transitionGuards ?? []);
    checkpoint.steps[step.id] = "attempted"; runner.save(checkpoint);
    const result = runner.run(step.command);
    if (result.status !== 0) throw new Error(`upgrade submission uncertain: ${step.id}; checkpoint retained`);
    exact(step.guards); exact(step.transitionGuards ?? []); stable();
    checkpoint.steps[step.id] = "verified"; runner.save(checkpoint);
  }
  checkDrain(); exact(plan.finalGuards); stable();
  return checkpoint;
}

export function upgradedFundingRegistry(plan: FundingUpgradePlan): FundingUpgradeRegistry {
  return { ...plan.registry, wasmHashes: { ...plan.registry.wasmHashes,
    "funding-settlement": plan.evidence.artifacts.fundingWasm.sha256,
    "batch-settlement": plan.evidence.artifacts.batchWasm.sha256,
    "funding-update-proof-verifier": plan.evidence.artifacts.fundingVerifierWasm.sha256 },
    risc0BatchMatchImageId: plan.evidence.guest.imageId,
    risc0BatchMatchVerifierHash: plan.steps.find((step) => step.id === "rotate:batch-image")!.guards[1].expected };
}

export function fundingUpgradeTreeHash(path: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    ["target", ".git", "test_snapshots", ".DS_Store"].includes(entry.name) ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []).sort();
  for (const file of walk(path)) { hash.update(file.slice(path.length + 1)); hash.update("\0"); hash.update(readFileSync(file)); hash.update("\0"); }
  return `0x${hash.digest("hex")}`;
}

/** RISC0 v3 ProgramBinary envelope (risc0-binfmt 3.0.5), not a raw ELF.
 * SDK decoding and compute_image_id in the pinned host remain mandatory before
 * execution; this local check only rejects the wrong format or truncated parts.
 */
export function assertRisc0ProgramBinary(program: Buffer): void {
  const invalid = () => { throw new Error("invalid RISC0 ProgramBinary artifact"); };
  if (program.length < 24 || program.subarray(0, 4).toString("ascii") !== "R0BF" || program.readUInt32LE(4) !== 1) invalid();
  const headerLength = program.readUInt32LE(8);
  const userLengthOffset = 12 + headerLength;
  if (headerLength === 0 || userLengthOffset > program.length - 4) invalid();
  const userLength = program.readUInt32LE(userLengthOffset);
  const userOffset = userLengthOffset + 4, kernelOffset = userOffset + userLength;
  const elfMagic = Buffer.from([127, 69, 76, 70]);
  if (userLength < 4 || kernelOffset > program.length - 4 ||
      !program.subarray(userOffset, userOffset + 4).equals(elfMagic) ||
      !program.subarray(kernelOffset, kernelOffset + 4).equals(elfMagic)) invalid();
}
const digestBytes = (value: string | Uint8Array): string => `0x${createHash("sha256").update(value).digest("hex")}`;
const digest = (value: unknown): string => digestBytes(JSON.stringify(value));
const fileHash = (path: string): string => digestBytes(readFileSync(path));
const bare = (value: string): string => hash32(value).slice(2);
function hash32(value: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value) || BigInt(value) === 0n) throw new Error("invalid artifact identity");
  return value.toLowerCase();
}
function address(value: string, kind: "C" | "G"): void { if (!new RegExp(`^${kind}[A-Z2-7]{55}$`).test(value ?? "")) throw new Error("invalid deployment address"); }
function normalize(value: string | Uint8Array): string {
  const text = Buffer.from(value).toString("utf8").trim();
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (parsed && typeof parsed === "object" && "ok" in parsed) parsed = (parsed as { ok: unknown }).ok;
  const result = parsed === null ? "null" : String(parsed);
  return /^(?:0x)?[0-9a-f]{64}$/i.test(result) ? `0x${result.replace(/^0x/i, "").toLowerCase()}` : result;
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
}

if (import.meta.main) {
  const argument = (name: string, fallback?: string): string => {
    const index = process.argv.indexOf(name), value = index < 0 ? fallback : process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
    return resolve(value);
  };
  const registryPath = argument("--registry", "deployments/testnet.json");
  const evidencePath = argument("--evidence");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  const sourceArgument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
    return value;
  };
  const plan = createFundingUpgradePlan(registry, JSON.parse(readFileSync(evidencePath, "utf8")), {
    adminSource: sourceArgument("--admin-source"), upgradeSource: sourceArgument("--upgrade-source"),
  });
  if (!process.argv.includes("--execute")) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, ...plan }, null, 2)}\n`);
  } else {
    const drainPath = argument("--drain-snapshot"), checkpointPath = argument("--checkpoint", `${registryPath}.funding.partial`);
    const previous = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) : undefined;
    executeFundingUpgrade(plan, {
      drain: () => JSON.parse(readFileSync(drainPath, "utf8")), save: (checkpoint) => atomicJson(checkpointPath, checkpoint),
      run: (command) => {
        const result = spawnSync(command.argv[0], command.argv.slice(1), { encoding: "buffer", timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...command.env } });
        return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr?.toString("utf8") };
      },
    }, previous);
    if (JSON.stringify(JSON.parse(readFileSync(registryPath, "utf8"))) !== JSON.stringify(registry)) throw new Error("deployment registry changed during the upgrade");
    atomicJson(registryPath, upgradedFundingRegistry(plan));
    process.stdout.write(`${JSON.stringify({ complete: true, fingerprint: plan.fingerprint, workersRemainStopped: true })}\n`);
  }
}
