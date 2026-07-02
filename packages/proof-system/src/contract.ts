import { hashFields } from "@pnlx/crypto";
import type { Hex, ProofMeta } from "@pnlx/protocol-types";
import type { CircuitId, CircuitMeta } from "./circuits";

export interface ContractProofMeta {
  circuitId: Hex;
  circuitHash: Hex;
  verifierHash: Hex;
  publicInputHash: Hex;
  proofDigest: Hex;
}

export interface VerifierEntry {
  circuitId: Hex;
  verifierHash: Hex;
}

export function circuitKey(circuitId: CircuitId | string): Hex {
  return hashFields("circuit-id", [circuitId]);
}

export function verifierEntry(circuit: CircuitMeta): VerifierEntry {
  return {
    circuitId: circuitKey(circuit.id),
    verifierHash: circuit.verifierHash,
  };
}

export function toContractProof(proof: ProofMeta): ContractProofMeta {
  return {
    circuitId: proof.circuitKey,
    circuitHash: proof.circuitHash,
    verifierHash: proof.verifierHash,
    publicInputHash: proof.publicInputHash,
    proofDigest: proof.proofDigest,
  };
}
