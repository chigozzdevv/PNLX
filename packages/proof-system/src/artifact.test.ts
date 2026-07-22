import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { buildProofArtifact, buildProofArtifactAsync } from "./artifact";
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

  test("builds an ultrahonk proof without blocking the event loop", async () => {
    let eventLoopAdvanced = false;
    const tick = setTimeout(() => {
      eventLoopAdvanced = true;
    }, 0);
    const artifact = await buildProofArtifactAsync(process.cwd(), "margin-check");
    clearTimeout(tick);

    expect(eventLoopAdvanced).toBe(true);
    expect(artifact.circuitKey).toBe(circuitKey("margin-check"));
    expect(artifact.proofHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(existsSync(artifact.proofPath)).toBe(true);
  });
});
