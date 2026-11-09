import type { Hex, IntentValidityRecord, IntentValidityWitness, ProofMeta } from "@pnlx/protocol-types";
import type { ProverService } from "@/workers/prover/prover.service";

type ProofArtifactRegistration = Parameters<ProverService["registerProofArtifact"]>[0];
type JsonFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20 * 60_000;
const HEX_PATTERN = /^0x[0-9a-fA-F]+$/;

export class RemoteIntentValidityProver {
  private readonly url: string;

  constructor(
    baseUrl: string,
    private readonly registerProofArtifact: (input: ProofArtifactRegistration) => unknown,
    private readonly fetcher: JsonFetch = fetch,
  ) {
    this.url = new URL("/intent-validity", baseUrl).toString();
  }

  async prove(input: IntentValidityWitness): Promise<IntentValidityRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const { intent, ...witness } = input;
      const response = await this.fetcher(this.url, {
        body: JSON.stringify({ ...witness, ...intent }, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`prover service failed with status ${response.status}`);

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("prover service returned invalid JSON");
      }
      const payload = objectValue(body, "prover response");
      const artifact = parseArtifactRegistration(payload.artifact);
      const record = parseIntentValidityRecord(payload.record);
      if (!sameProof(record.proof, artifact.proof)) {
        throw new Error("prover response proof metadata mismatch");
      }

      this.registerProofArtifact(artifact);
      return record;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("prover ")) throw error;
      if (error instanceof Error && error.message.endsWith("mismatch")) throw error;
      if (controller.signal.aborted) throw new Error("prover service request timed out");
      throw new Error("prover service request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseArtifactRegistration(value: unknown): ProofArtifactRegistration {
  const artifact = objectValue(value, "proof artifact");
  const proof = parseProofMeta(artifact.proof);
  if (proof.circuitId !== "intent-validity") throw new Error("prover returned an unexpected proof circuit");
  return {
    ...(artifact.bytecodeHash === undefined ? {} : { bytecodeHash: hexValue(artifact.bytecodeHash, "bytecode hash") }),
    proof,
    proofBase64: stringValue(artifact.proofBase64, "proof artifact"),
    publicInputsBase64: stringValue(artifact.publicInputsBase64, "public inputs artifact"),
    vkBase64: stringValue(artifact.vkBase64, "verifier artifact"),
    ...(artifact.witnessHash === undefined ? {} : { witnessHash: hexValue(artifact.witnessHash, "witness hash") }),
  };
}

function parseIntentValidityRecord(value: unknown): IntentValidityRecord {
  const record = objectValue(value, "intent validity record");
  const hexFields = [
    "assetDigest",
    "matchingPayloadCommitment",
    "ownerDigest",
    "positionSeed",
    "batchDigest",
    "intentCommitment",
    "marketDigest",
    "noteChangeCommitment",
    "noteCommitment",
    "marginRoot",
    "noteNullifier",
    "ownerCommitmentField",
  ] as const;
  const parsedHex = Object.fromEntries(hexFields.map((field) => [field, hexValue(record[field], field)]));
  return {
    ...parsedHex,
    currentBatch: bigintValue(record.currentBatch, "current batch"),
    expiryBatch: bigintValue(record.expiryBatch, "expiry batch"),
    proof: parseProofMeta(record.proof),
  } as IntentValidityRecord;
}

function parseProofMeta(value: unknown): ProofMeta {
  const proof = objectValue(value, "proof metadata");
  return {
    ...proof,
    circuitId: stringValue(proof.circuitId, "proof circuit"),
    circuitKey: hexValue(proof.circuitKey, "proof circuit key"),
    circuitHash: hexValue(proof.circuitHash, "proof circuit hash"),
    verifierHash: hexValue(proof.verifierHash, "proof verifier hash"),
    publicInputHash: hexValue(proof.publicInputHash, "proof public input hash"),
    proofDigest: hexValue(proof.proofDigest, "proof digest"),
  } as ProofMeta;
}

function sameProof(left: ProofMeta, right: ProofMeta): boolean {
  return left.circuitId === right.circuitId &&
    left.circuitKey === right.circuitKey &&
    left.circuitHash === right.circuitHash &&
    left.verifierHash === right.verifierHash &&
    left.publicInputHash === right.publicInputHash &&
    left.proofDigest === right.proofDigest;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`prover returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`prover returned invalid ${label}`);
  return value;
}

function hexValue(value: unknown, label: string): Hex {
  const result = stringValue(value, label);
  if (!HEX_PATTERN.test(result)) throw new Error(`prover returned invalid ${label}`);
  return result as Hex;
}

function bigintValue(value: unknown, label: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`prover returned invalid ${label}`);
  }
  const result = String(value);
  if (!/^-?\d+$/.test(result)) throw new Error(`prover returned invalid ${label}`);
  return BigInt(result);
}
