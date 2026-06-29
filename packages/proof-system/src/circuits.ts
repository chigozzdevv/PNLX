import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hashFields } from "@merkl/crypto";
import type { Hex } from "@merkl/protocol-types";

export type CircuitId =
  | "batch-match"
  | "conditional-close"
  | "deposit-note"
  | "disclosure"
  | "funding-update"
  | "intent-validity"
  | "liquidation-check"
  | "margin-check"
  | "position-close"
  | "position-transition"
  | "withdraw";

export interface CircuitDef {
  id: CircuitId;
  packageName: string;
  dir: string;
}

export interface CircuitMeta extends CircuitDef {
  sourceHash: Hex;
  verifierHash: Hex;
  verifierSource: "artifact" | "source";
}

export const CIRCUITS: CircuitDef[] = [
  { id: "batch-match", packageName: "batch_match", dir: "circuits/batch-match" },
  { id: "conditional-close", packageName: "conditional_close", dir: "circuits/conditional-close" },
  { id: "deposit-note", packageName: "deposit_note", dir: "circuits/deposit-note" },
  { id: "disclosure", packageName: "disclosure", dir: "circuits/disclosure" },
  { id: "funding-update", packageName: "funding_update", dir: "circuits/funding-update" },
  { id: "intent-validity", packageName: "intent_validity", dir: "circuits/intent-validity" },
  { id: "liquidation-check", packageName: "liquidation_check", dir: "circuits/liquidation-check" },
  { id: "margin-check", packageName: "margin_check", dir: "circuits/margin-check" },
  { id: "position-close", packageName: "position_close", dir: "circuits/position-close" },
  { id: "position-transition", packageName: "position_transition", dir: "circuits/position-transition" },
  { id: "withdraw", packageName: "withdraw", dir: "circuits/withdraw" },
];

function hashFile(path: string): Hex {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `0x${hash}`;
}

export function loadCircuit(root: string, id: CircuitId): CircuitMeta {
  const circuit = CIRCUITS.find((item) => item.id === id);
  if (!circuit) throw new Error(`unknown circuit: ${id}`);

  const nargo = readFileSync(join(root, circuit.dir, "Nargo.toml"), "utf8");
  const main = readFileSync(join(root, circuit.dir, "src/main.nr"), "utf8");
  const sourceHash = hashFields("circuit-source", [circuit.id, circuit.packageName, nargo, main]);
  const vkPath = join(root, circuit.dir, "target/bb/vk");
  const hasVerifierArtifact = existsSync(vkPath);
  const verifierHash = hasVerifierArtifact
    ? hashFile(vkPath)
    : hashFields("circuit-verifier", [circuit.id, sourceHash]);

  return {
    ...circuit,
    sourceHash,
    verifierHash,
    verifierSource: hasVerifierArtifact ? "artifact" : "source",
  };
}

export function loadCircuits(root: string): Map<CircuitId, CircuitMeta> {
  return new Map(CIRCUITS.map((circuit) => [circuit.id, loadCircuit(root, circuit.id)]));
}
