import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { buildProofArtifact } from "./artifact";
import { loadCircuit } from "./circuits";
import { circuitKey } from "./contract";

describe("proof artifact builder", () => {
  test("builds and verifies a real ultrahonk proof", () => {
    const artifact = buildProofArtifact(process.cwd(), "margin-check");

    expect(artifact.circuitId).toBe("margin-check");
    expect(artifact.circuitKey).toBe(circuitKey("margin-check"));
    expect(artifact.bytecodeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(artifact.witnessHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(artifact.proofHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(artifact.publicInputsHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(artifact.vkHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(existsSync(artifact.proofPath)).toBe(true);
    expect(existsSync(artifact.publicInputsPath)).toBe(true);
    expect(existsSync(artifact.vkPath)).toBe(true);

    const circuit = loadCircuit(process.cwd(), "margin-check");
    expect(circuit.verifierSource).toBe("artifact");
    expect(circuit.verifierHash).toBe(artifact.vkHash);
  });
});
