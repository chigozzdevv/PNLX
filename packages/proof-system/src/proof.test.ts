import { describe, expect, test } from "bun:test";
import { CIRCUITS, loadCircuit, loadCircuits } from "./circuits";
import { circuitKey, toContractProof, verifierEntry } from "./contract";
import { bindProof, publicInputDigest } from "./proof";

describe("proof system", () => {
  test("loads every circuit manifest and source hash", () => {
    const circuits = loadCircuits(process.cwd());

    expect(circuits.size).toBe(CIRCUITS.length);
    for (const circuit of CIRCUITS) {
      const meta = circuits.get(circuit.id);
      expect(meta?.id).toBe(circuit.id);
      expect(meta?.packageName).toBe(circuit.packageName);
      expect(meta?.sourceHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(meta?.verifierHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  test("binds proof digests to circuit metadata and public inputs", () => {
    const circuit = loadCircuit(process.cwd(), "intent-validity");
    const firstInputs = publicInputDigest("intent-validity", ["batch-1", "btc-usd", 2n]);
    const nextInputs = publicInputDigest("intent-validity", ["batch-1", "btc-usd", 3n]);

    const firstProof = bindProof(circuit, firstInputs);
    const sameProof = bindProof(circuit, firstInputs);
    const nextProof = bindProof(circuit, nextInputs);

    expect(firstProof).toEqual(sameProof);
    expect(firstProof.proofDigest).not.toBe(nextProof.proofDigest);
    expect(firstProof.circuitKey).toBe(circuitKey("intent-validity"));
    expect(firstProof.circuitHash).toBe(circuit.sourceHash);
    expect(firstProof.verifierHash).toBe(circuit.verifierHash);
    expect(firstProof.publicInputHash).toBe(firstInputs);
  });

  test("creates contract proof metadata and verifier registry entries", () => {
    const circuit = loadCircuit(process.cwd(), "withdraw");
    const publicInputs = publicInputDigest("withdraw", ["root", "nullifier"]);
    const proof = bindProof(circuit, publicInputs);
    const contractProof = toContractProof(proof);
    const entry = verifierEntry(circuit);

    expect(contractProof.circuitId).toBe(proof.circuitKey);
    expect(contractProof.circuitHash).toBe(proof.circuitHash);
    expect(contractProof.verifierHash).toBe(entry.verifierHash);
    expect(entry.circuitId).toBe(circuitKey("withdraw"));
  });
});
