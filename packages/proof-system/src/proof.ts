import { hashFields } from "@merkl/crypto";
import type { Hex, ProofMeta } from "@merkl/protocol-types";
import type { ProofArtifact } from "./artifact";
import type { CircuitMeta } from "./circuits";
import { circuitKey } from "./contract";

export function publicInputDigest(domain: string, inputs: unknown[]): Hex {
  return hashFields(`public-inputs:${domain}`, inputs);
}

export function bindProof(
  circuit: CircuitMeta,
  publicInputs: Hex,
  artifact?: ProofArtifact,
): ProofMeta {
  if (artifact && artifact.circuitId !== circuit.id) {
    throw new Error("proof artifact circuit mismatch");
  }
  const key = circuitKey(circuit.id);
  const verifierHash = artifact?.vkHash ?? circuit.verifierHash;
  const publicInputHash = artifact?.publicInputsHash ?? publicInputs;
  const proofDigest =
    artifact?.proofHash ??
    hashFields("bound-proof", [circuit.id, key, circuit.sourceHash, verifierHash, publicInputs]);

  return {
    circuitId: circuit.id,
    circuitKey: key,
    circuitHash: circuit.sourceHash,
    verifierHash,
    publicInputHash,
    proofDigest,
    bytecodeHash: artifact?.bytecodeHash,
    witnessHash: artifact?.witnessHash,
    proofHash: artifact?.proofHash,
    publicInputsHash: artifact?.publicInputsHash,
    vkHash: artifact?.vkHash,
  };
}
