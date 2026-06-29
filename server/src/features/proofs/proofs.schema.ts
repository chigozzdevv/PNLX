import { parseDisclosure } from "../disclosures/disclosures.schema";
import { parseIntentValidityWitness } from "../intents/intents.schema";
import { parseProofMeta } from "../intents/intents.schema";
import { parseLiquidation } from "../liquidations/liquidations.schema";
import type { ProofArtifactRegistrationInput } from "./proofs.model";

export const parseLiquidationProof = parseLiquidation;
export const parseDisclosureProof = parseDisclosure;
export const parseIntentValidityProof = parseIntentValidityWitness;

export function parseProofArtifactRegistration(
  input: Record<string, unknown>,
): ProofArtifactRegistrationInput {
  return {
    bytecodeHash: optionalHex(input.bytecodeHash),
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
    proofBase64: requiredBase64(input.proofBase64, "proofBase64"),
    publicInputsBase64: requiredBase64(input.publicInputsBase64, "publicInputsBase64"),
    vkBase64: requiredBase64(input.vkBase64, "vkBase64"),
    witnessHash: optionalHex(input.witnessHash),
  };
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as Record<string, unknown>;
}

function requiredBase64(value: unknown, field: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${field} is required`);
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) throw new Error(`${field} must be base64`);
  return raw;
}

function optionalHex(value: unknown): `0x${string}` | undefined {
  return value === undefined || value === "" ? undefined : (String(value) as `0x${string}`);
}
