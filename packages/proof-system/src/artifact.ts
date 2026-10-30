import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { join } from "node:path";
import type { Hex } from "@pnlx/protocol-types";
import type { CircuitId } from "./circuits";
import { loadCircuit } from "./circuits";
import { circuitKey } from "./contract";

export interface ProofArtifact {
  circuitId: string;
  circuitKey: Hex;
  bytecodeHash: Hex;
  witnessHash: Hex;
  proofHash: Hex;
  publicInputsHash: Hex;
  vkHash: Hex;
  proofPath: string;
  publicInputsPath: string;
  vkPath: string;
}

export type ProverValue = bigint | boolean | number | string | ProverValue[];
export type ProverInput = Record<string, ProverValue>;

export interface ProofArtifactOptions {
  name?: string;
  inputs?: ProverInput;
}

interface ProofArtifactPlan {
  bbDir: string;
  bytecodePath: string;
  commands: Array<{ args: string[]; command: string }>;
  dir: string;
  env: NodeJS.ProcessEnv;
  id: CircuitId;
  inputs?: ProverInput;
  proofPath: string;
  proverPath?: string;
  publicInputsPath: string;
  vkPath: string;
  witnessPath: string;
}

function hashFile(path: string): Hex {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `0x${hash}`;
}

const DEFAULT_NOIR_COMMAND_TIMEOUT_MS = 120_000;
const MAX_NOIR_COMMAND_TIMEOUT_MS = 15 * 60_000;

function commandTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.PNLX_NOIR_PROVER_TIMEOUT_MS ?? DEFAULT_NOIR_COMMAND_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_NOIR_COMMAND_TIMEOUT_MS) {
    throw new Error("PNLX_NOIR_PROVER_TIMEOUT_MS must be a positive integer no greater than 900000");
  }
  return value;
}

function terminateProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
  catch { /* The completed process group may already have exited. */ }
}

export function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const timeout = commandTimeoutMs(env);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(command, args, {
      cwd, env, timeout, killSignal: "SIGKILL",
      // Tool output can contain witness fields. Discard it rather than retaining or exposing it.
      stdio: "ignore", maxBuffer: 65_536,
    });
  } catch { throw new Error("Noir prover command failed to start"); }
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error("Noir prover command deadline exceeded");
  }
  if (result.status !== 0) throw new Error("Noir prover command failed");
}

export async function runAsync(
  command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const timeout = commandTimeoutMs(env);
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd, env, detached: process.platform !== "win32", stdio: "ignore",
      });
    } catch { reject(new Error("Noir prover command failed to start")); return; }
    let completed = false;
    const timer = setTimeout(() => finish(new Error("Noir prover command deadline exceeded")), timeout);
    function finish(error?: Error): void {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      terminateProcessGroup(child.pid);
      if (error) reject(error);
      else resolve();
    }
    child.on("error", () => finish(new Error("Noir prover command failed to start")));
    child.on("close", (status) => finish(status === 0 ? undefined : new Error("Noir prover command failed")));
  });
}

function artifactName(circuit: CircuitId, name?: string): string {
  const raw = name ?? circuit;
  const clean = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!clean) throw new Error("invalid proof artifact name");
  return clean;
}

function tomlValue(value: ProverValue): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") {
    // TOML integers are signed 64-bit; Noir also accepts quoted decimal fields/u128s.
    return value > 9_223_372_036_854_775_807n || value < -9_223_372_036_854_775_808n
      ? JSON.stringify(value.toString()) : value.toString();
  }
  if (typeof value === "number") return Math.trunc(value).toString();
  if (/^-?\d+$/.test(value)) return tomlValue(BigInt(value));
  return JSON.stringify(value);
}

function writeProverInput(path: string, input: ProverInput): void {
  const body = Object.entries(input)
    .map(([key, value]) => `${key} = ${tomlValue(value)}`)
    .join("\n");
  writeFileSync(path, `${body}\n`, { flag: "wx", mode: 0o600 });
}

export function buildProofArtifact(
  root: string,
  id: CircuitId,
  options: ProofArtifactOptions = {},
): ProofArtifact {
  const plan = prepareProofArtifact(root, id, options);
  try {
    preparePrivateWitness(plan);
    for (const command of plan.commands) {
      run(command.command, command.args, plan.dir, plan.env);
    }
    return completeProofArtifact(plan);
  } finally {
    clearPrivateWitness(plan);
  }
}

export async function buildProofArtifactAsync(
  root: string,
  id: CircuitId,
  options: ProofArtifactOptions = {},
): Promise<ProofArtifact> {
  const circuit = loadCircuit(root, id);
  const source = join(root, circuit.dir);
  const workRoot = join(root, ".pnlx", "proof-work");
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(workRoot, `${id}-`));
  const output = join(source, "target", "bb", `async-${randomUUID()}`);
  try {
    // Each process owns its compiler outputs and caches as well as its witness.
    // Other API/maker processes can continue proving against the original circuit.
    copyFileSync(join(source, "Nargo.toml"), join(workspace, "Nargo.toml"));
    cpSync(join(source, "src"), join(workspace, "src"), { recursive: true });
    if (existsSync(join(source, "Nargo.lock"))) {
      copyFileSync(join(source, "Nargo.lock"), join(workspace, "Nargo.lock"));
    }
    if (!options.inputs) copyFileSync(join(source, "Prover.toml"), join(workspace, "Prover.toml"));
    const plan = prepareProofArtifact(root, id, options, workspace);
    preparePrivateWitness(plan);
    for (const command of plan.commands) {
      await runAsync(command.command, command.args, plan.dir, plan.env);
    }
    const artifact = completeProofArtifact(plan);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const proofPath = join(output, "proof");
    const publicInputsPath = join(output, "public_inputs");
    const vkPath = join(output, "vk");
    copyFileSync(artifact.proofPath, proofPath);
    copyFileSync(artifact.publicInputsPath, publicInputsPath);
    copyFileSync(artifact.vkPath, vkPath);
    return { ...artifact, proofPath, publicInputsPath, vkPath };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function preparePrivateWitness(plan: ProofArtifactPlan): void {
  rmSync(plan.bbDir, { recursive: true, force: true });
  if (plan.proverPath && plan.inputs) writeProverInput(plan.proverPath, plan.inputs);
}

function clearPrivateWitness(plan: ProofArtifactPlan): void {
  if (!plan.proverPath) return;
  rmSync(plan.proverPath, { force: true });
  rmSync(plan.witnessPath, { force: true });
}

function prepareProofArtifact(
  root: string,
  id: CircuitId,
  options: ProofArtifactOptions,
  workspace?: string,
): ProofArtifactPlan {
  const circuit = loadCircuit(root, id);
  const dir = workspace ?? join(root, circuit.dir);
  const target = join(dir, "target");
  const isCustom = Boolean(options.inputs);
  const name = isCustom
    ? `${artifactName(id, options.name)}-${randomUUID()}`
    : artifactName(id, options.name);
  const bbDir = isCustom ? join(target, "bb", name) : join(target, "bb");
  const bytecodePath = join(target, `${circuit.packageName}.json`);
  const witnessPath = join(target, `${isCustom ? name : circuit.packageName}.gz`);
  const proofPath = join(bbDir, "proof");
  const publicInputsPath = join(bbDir, "public_inputs");
  const vkPath = join(bbDir, "vk");
  const proverDir = join(target, "provers");
  const proverPath = join(proverDir, `${name}.toml`);
  const cacheDir = join(workspace ?? root, ".pnlx", "proof-cache");
  const proofHome = join(workspace ?? root, ".pnlx", "proof-home");
  const toolHome = process.env.HOME || "";
  const proofEnv = {
    ...process.env,
    HOME: proofHome,
    NARGO_HOME: join(cacheDir, "nargo-home"),
    NOIR_CACHE_DIR: join(cacheDir, "noir"),
    PATH: proofToolPath(toolHome, process.env.PATH),
    XDG_CACHE_HOME: cacheDir,
  };

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(proofHome, { recursive: true });
  const cachedCrs = join(root, ".pnlx", "proof-home", ".bb-crs");
  if (workspace && existsSync(cachedCrs)) {
    // CRS parameters are public. Copy-on-write where available keeps each job's
    // parameter cache independent without redownloading already cached data.
    cpSync(cachedCrs, join(proofHome, ".bb-crs"), { recursive: true, mode: constants.COPYFILE_FICLONE });
  }

  if (!options.inputs && !existsSync(join(dir, "Prover.toml"))) {
    throw new Error(`missing prover inputs for ${id}`);
  }
  if (options.inputs) mkdirSync(proverDir, { recursive: true, mode: 0o700 });
  return {
    bbDir,
    bytecodePath,
    commands: [
      {
        args: options.inputs ? ["execute", "-p", `target/provers/${name}`, name] : ["execute"],
        command: "nargo",
      },
      { args: ["compile"], command: "nargo" },
      {
        args: [
          "prove",
          "-s",
          "ultra_honk",
          "-b",
          bytecodePath,
          "-w",
          witnessPath,
          "-o",
          bbDir,
          "--write_vk",
          "--oracle_hash",
          "keccak",
        ],
        command: "bb",
      },
      {
        args: [
          "verify",
          "-s",
          "ultra_honk",
          "-i",
          publicInputsPath,
          "-p",
          proofPath,
          "-k",
          vkPath,
          "--oracle_hash",
          "keccak",
        ],
        command: "bb",
      },
    ],
    dir,
    env: proofEnv,
    id,
    inputs: options.inputs,
    proofPath,
    publicInputsPath,
    proverPath: options.inputs ? proverPath : undefined,
    vkPath,
    witnessPath,
  };
}

function completeProofArtifact(plan: ProofArtifactPlan): ProofArtifact {
  return {
    circuitId: plan.id,
    circuitKey: circuitKey(plan.id),
    bytecodeHash: hashFile(plan.bytecodePath),
    witnessHash: hashFile(plan.witnessPath),
    proofHash: hashFile(plan.proofPath),
    publicInputsHash: hashFile(plan.publicInputsPath),
    vkHash: hashFile(plan.vkPath),
    proofPath: plan.proofPath,
    publicInputsPath: plan.publicInputsPath,
    vkPath: plan.vkPath,
  };
}

function proofToolPath(home: string, existingPath = ""): string {
  return [
    home ? join(home, ".nargo", "bin") : "",
    home ? join(home, ".bb", "bin") : "",
    existingPath,
  ].filter(Boolean).join(delimiter);
}
