import type { CreateDisclosureInput, CreateProvenDisclosureInput } from "@/features/disclosures/disclosures.model";
import { parseProofMeta } from "@/features/intents/intents.schema";

export function parseDisclosure(input: Record<string, unknown>): CreateDisclosureInput {
  return {
    subject: String(input.subject) as `0x${string}`,
    claim: String(input.claim),
    root: String(input.root) as `0x${string}`,
    salt: String(input.salt),
    saltDigest: String(input.saltDigest) as `0x${string}`,
    value: BigInt(String(input.value)),
    threshold: BigInt(String(input.threshold)),
    pathIndices: parseBooleanArray(input.pathIndices),
    pathSiblings: parseHexArray(input.pathSiblings),
  };
}

export function parseProvenDisclosure(input: Record<string, unknown>): CreateProvenDisclosureInput {
  return {
    disclosureId: String(input.disclosureId) as `0x${string}`,
    subject: String(input.subject) as `0x${string}`,
    claimDigest: String(input.claimDigest) as `0x${string}`,
    root: String(input.root) as `0x${string}`,
    threshold: BigInt(String(input.threshold)),
    proof: parseProofMeta(requiredObject(input.proof, "proof")),
  };
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return value as Record<string, unknown>;
}

function parseBooleanArray(value: unknown): boolean[] {
  if (!Array.isArray(value)) throw new Error("pathIndices must be an array");
  return value.map((entry) => entry === true || entry === "true");
}

function parseHexArray(value: unknown): `0x${string}`[] {
  if (!Array.isArray(value)) throw new Error("pathSiblings must be an array");
  return value.map((entry) => String(entry) as `0x${string}`);
}
