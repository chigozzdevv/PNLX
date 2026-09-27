import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

  test("removes private prover inputs and witness after proving", () => {
    const name = "private-witness-cleanup-test";
    const target = join(process.cwd(), "circuits", "margin-check", "target");
    const artifact = buildProofArtifact(process.cwd(), "margin-check", {
      name,
      inputs: {
        size: 1n, price: 5_000_000_000_000n, margin: 12_000n,
        initial_rate: 200_000n, max_leverage: 5n,
        price_scale: 100_000_000n, rate_scale: 1_000_000n,
      },
    });
    expect(artifact.witnessHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(readdirSync(join(target, "provers")).filter((file) => file.startsWith(`${name}-`))).toEqual([]);
    expect(readdirSync(target).filter((file) => file.startsWith(`${name}-`) && file.endsWith(".gz"))).toEqual([]);
  });

  test("removes private prover inputs when proof generation fails", () => {
    const name = "private-witness-failure-test";
    const target = join(process.cwd(), "circuits", "margin-check", "target");
    expect(() => buildProofArtifact(process.cwd(), "margin-check", {
      name,
      inputs: {
        size: 1n, price: 5_000_000_000_000n, margin: 1n,
        initial_rate: 200_000n, max_leverage: 5n,
        price_scale: 100_000_000n, rate_scale: 1_000_000n,
      },
    })).toThrow();
    expect(readdirSync(join(target, "provers")).filter((file) => file.startsWith(`${name}-`))).toEqual([]);
    expect(readdirSync(target).filter((file) => file.startsWith(`${name}-`) && file.endsWith(".gz"))).toEqual([]);
  });

  test("isolates simultaneous private witnesses with the same requested name", async () => {
    const name = "private-witness-concurrent-test";
    const inputs = {
      size: 1n, price: 5_000_000_000_000n, margin: 12_000n,
      initial_rate: 200_000n, max_leverage: 5n,
      price_scale: 100_000_000n, rate_scale: 1_000_000n,
    };
    const [first, second] = await Promise.all([
      buildProofArtifactAsync(process.cwd(), "margin-check", { name, inputs }),
      buildProofArtifactAsync(process.cwd(), "margin-check", { name, inputs: { ...inputs, margin: 15_000n } }),
    ]);
    expect(first.proofPath).not.toBe(second.proofPath);
    expect(first.witnessHash).not.toBe(second.witnessHash);
    const target = join(process.cwd(), "circuits", "margin-check", "target");
    expect(readdirSync(join(target, "provers")).filter((file) => file.startsWith(`${name}-`))).toEqual([]);
    expect(readdirSync(target).filter((file) => file.startsWith(`${name}-`) && file.endsWith(".gz"))).toEqual([]);
  });
});
