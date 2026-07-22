import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  proofPath: string;
  publicInputsPath: string;
  vkPath: string;
  witnessPath: string;
}

function hashFile(path: string): Hex {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `0x${hash}`;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed\n${output}`);
  }
}

function runAsync(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) return resolve();
      reject(new Error(`${command} ${args.join(" ")} failed\n${stdout}\n${stderr}`.trim()));
    });
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
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Math.trunc(value).toString();
  if (/^-?\d+$/.test(value)) return value;
  return JSON.stringify(value);
}

function writeProverInput(path: string, input: ProverInput): void {
  const body = Object.entries(input)
    .map(([key, value]) => `${key} = ${tomlValue(value)}`)
    .join("\n");
  writeFileSync(path, `${body}\n`);
}

export function buildProofArtifact(
  root: string,
  id: CircuitId,
  options: ProofArtifactOptions = {},
): ProofArtifact {
  const plan = prepareProofArtifact(root, id, options);
  for (const command of plan.commands) {
    run(command.command, command.args, plan.dir, plan.env);
  }
  return completeProofArtifact(plan);
}

export async function buildProofArtifactAsync(
  root: string,
  id: CircuitId,
  options: ProofArtifactOptions = {},
): Promise<ProofArtifact> {
  const plan = prepareProofArtifact(root, id, options);
  for (const command of plan.commands) {
    await runAsync(command.command, command.args, plan.dir, plan.env);
  }
  return completeProofArtifact(plan);
}

function prepareProofArtifact(
  root: string,
  id: CircuitId,
  options: ProofArtifactOptions,
): ProofArtifactPlan {
  const circuit = loadCircuit(root, id);
  const dir = join(root, circuit.dir);
  const target = join(dir, "target");
  const name = artifactName(id, options.name);
  const isCustom = Boolean(options.inputs);
  const bbDir = isCustom ? join(target, "bb", name) : join(target, "bb");
  const bytecodePath = join(target, `${circuit.packageName}.json`);
  const witnessPath = join(target, `${isCustom ? name : circuit.packageName}.gz`);
  const proofPath = join(bbDir, "proof");
  const publicInputsPath = join(bbDir, "public_inputs");
  const vkPath = join(bbDir, "vk");
  const proverDir = join(target, "provers");
  const proverPath = join(proverDir, `${name}.toml`);
  const cacheDir = join(root, ".pnlx", "proof-cache");
  const proofHome = join(root, ".pnlx", "proof-home");
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

  if (!options.inputs && !existsSync(join(dir, "Prover.toml"))) {
    throw new Error(`missing prover inputs for ${id}`);
  }
  if (options.inputs) {
    mkdirSync(proverDir, { recursive: true });
    writeProverInput(proverPath, options.inputs);
  }

  rmSync(bbDir, { recursive: true, force: true });
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
    proofPath,
    publicInputsPath,
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
