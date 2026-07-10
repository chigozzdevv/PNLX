import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProofArtifact } from "@pnlx/proof-system";
import type { Hex, ProofMeta } from "@pnlx/protocol-types";
import { ProofArtifactRegistry } from "@/shared/proofs/artifact-registry";

describe("proof artifact registry", () => {
  test("preserves entries written by separate registry instances", () => {
    const root = mkdtempSync(join(tmpdir(), "pnlx-proof-registry-"));
    try {
      const path = join(root, ".pnlx", "proof-artifacts.json");
      const first = new ProofArtifactRegistry(path);
      const second = new ProofArtifactRegistry(path);
      const firstProof = proofMeta("11");
      const secondProof = proofMeta("22");

      first.set(firstProof, artifact(root, firstProof, "first"));
      second.set(secondProof, artifact(root, secondProof, "second"));

      const restarted = new ProofArtifactRegistry(path);
      expect(restarted.get(firstProof)?.circuitId).toBe("first");
      expect(restarted.get(secondProof)?.circuitId).toBe("second");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function artifact(root: string, proof: ProofMeta, circuitId: string): ProofArtifact {
  const directory = join(root, circuitId);
  mkdirSync(directory, { recursive: true });
  const proofPath = join(directory, "proof");
  const publicInputsPath = join(directory, "public_inputs");
  const vkPath = join(directory, "vk");
  writeFileSync(proofPath, circuitId);
  writeFileSync(publicInputsPath, circuitId);
  writeFileSync(vkPath, circuitId);
  return {
    bytecodeHash: hex("33"),
    circuitId,
    circuitKey: proof.circuitKey,
    proofHash: proof.proofDigest,
    proofPath,
    publicInputsHash: proof.publicInputHash,
    publicInputsPath,
    vkHash: proof.verifierHash,
    vkPath,
    witnessHash: hex("44"),
  };
}

function proofMeta(seed: string): ProofMeta {
  return {
    circuitHash: hex("55"),
    circuitId: `proof-${seed}`,
    circuitKey: hex(seed),
    proofDigest: hex(seed === "11" ? "66" : "77"),
    publicInputHash: hex(seed === "11" ? "88" : "99"),
    verifierHash: hex(seed === "11" ? "aa" : "bb"),
  };
}

function hex(byte: string): Hex {
  return `0x${byte.repeat(32)}`;
}
