import type {
  DisclosureInput,
  DisclosureRecord,
  Hex,
  IntentValidityRecord,
  IntentValidityWitness,
  LiquidationRecord,
  LiquidationWitness,
  ProofMeta,
} from "@pnlx/protocol-types";

export type LiquidationProofRequest = LiquidationWitness;
export type DisclosureProofRequest = DisclosureInput;
export type IntentValidityProofRequest = IntentValidityWitness;
export type LiquidationProofResult = LiquidationRecord;
export type DisclosureProofResult = DisclosureRecord;
export type IntentValidityProofResult = IntentValidityRecord;

export interface ProofArtifactRegistrationInput {
  bytecodeHash?: Hex;
  proof: ProofMeta;
  proofBase64: string;
  publicInputsBase64: string;
  vkBase64: string;
  witnessHash?: Hex;
}

export interface VerifierRegistryItem {
  circuitId: string;
  circuitKey: Hex;
  circuitHash: Hex;
  verifierHash: Hex;
  verifierAuthority: string;
  verifierContract: string;
}
