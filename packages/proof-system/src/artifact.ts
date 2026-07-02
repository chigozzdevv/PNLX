import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function hashFile(path: string): Hex {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `0x${hash}`;
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed\n${output}`);
  }
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
  const proofEnv = {
    ...process.env,
    HOME: proofHome,
    NARGO_HOME: join(cacheDir, "nargo-home"),
    NOIR_CACHE_DIR: join(cacheDir, "noir"),
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
  run(
    "nargo",
    options.inputs ? ["execute", "-p", `target/provers/${name}`, name] : ["execute"],
    dir,
    proofEnv,
  );
  run("nargo", ["compile"], dir, proofEnv);
  run(
    "bb",
    [
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
    dir,
    proofEnv,
  );
  run(
    "bb",
    [
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
    dir,
    proofEnv,
  );

  return {
    circuitId: id,
    circuitKey: circuitKey(id),
    bytecodeHash: hashFile(bytecodePath),
    witnessHash: hashFile(witnessPath),
    proofHash: hashFile(proofPath),
    publicInputsHash: hashFile(publicInputsPath),
    vkHash: hashFile(vkPath),
    proofPath,
    publicInputsPath,
    vkPath,
  };
}
