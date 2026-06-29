import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { BatchSettlement } from "@merkl/protocol-types";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import { decodeStellarPublicKey } from "@/features/auth/auth.service";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";
import { externalMatcherTranscriptHash } from "@/shared/protocol/external-matcher-transcript";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface MatcherCommitteeConfig {
  addresses: string[];
  required: boolean;
  threshold: number;
}

export function assertMatcherCommitteeAttestation(
  transcript: Pick<ExternalBatchSettlementTranscript, "accountEvents" | "attestation" | "positionOpenings" | "residualOrders" | "settlement">,
  config: MatcherCommitteeConfig,
): void {
  if (!config.required) return;
  if (config.threshold < 1) throw new Error("matcher committee threshold must be at least 1");
  if (config.addresses.length < config.threshold) {
    throw new Error("matcher committee is not configured");
  }
  const { attestation, settlement } = transcript;
  if (!attestation) throw new Error("external matcher attestation is required");

  const expectedPublicInputHash = batchSettlementPublicInputHash(settlement);
  const expectedTranscriptHash = externalMatcherTranscriptHash(transcript);
  if (attestation.publicInputHash.toLowerCase() !== expectedPublicInputHash.toLowerCase()) {
    throw new Error("external matcher attestation public input mismatch");
  }
  if (attestation.transcriptHash.toLowerCase() !== expectedTranscriptHash.toLowerCase()) {
    throw new Error("external matcher attestation transcript mismatch");
  }
  if (attestation.settlementDigest.toLowerCase() !== settlement.settlementDigest.toLowerCase()) {
    throw new Error("external matcher attestation settlement mismatch");
  }

  const allowed = new Set(config.addresses.map(normalizeAddress));
  const message = matcherAttestationMessage(transcript, expectedPublicInputHash, expectedTranscriptHash);
  const accepted = new Set<string>();
  for (const entry of attestation.signatures) {
    const signer = normalizeAddress(entry.signer);
    if (!allowed.has(signer) || accepted.has(signer)) continue;
    if (verifyMatcherSignature(signer, message, entry.signature)) {
      accepted.add(signer);
    }
  }

  if (accepted.size < config.threshold) {
    throw new Error("external matcher attestation threshold not met");
  }
}

export function matcherAttestationMessage(
  transcript: Pick<ExternalBatchSettlementTranscript, "accountEvents" | "positionOpenings" | "residualOrders" | "settlement"> | BatchSettlement,
  publicInputHash?: string,
  transcriptHash?: string,
): string {
  const settlement = isSettlement(transcript) ? transcript : transcript.settlement;
  const resolvedPublicInputHash = publicInputHash ?? batchSettlementPublicInputHash(settlement);
  const resolvedTranscriptHash = transcriptHash ?? (
    isSettlement(transcript) ? "0x0" : externalMatcherTranscriptHash(transcript)
  );
  return [
    "Merkl external batch settlement",
    `Batch: ${settlement.batchId}`,
    `Market: ${settlement.marketId}`,
    `Settlement Digest: ${settlement.settlementDigest}`,
    `Public Input Hash: ${resolvedPublicInputHash}`,
    `Transcript Hash: ${resolvedTranscriptHash}`,
  ].join("\n");
}

function isSettlement(value: unknown): value is BatchSettlement {
  return Boolean(value && typeof value === "object" && "settlementDigest" in value);
}

function verifyMatcherSignature(address: string, message: string, signatureBase64: string): boolean {
  try {
    const publicKey = decodeStellarPublicKey(address);
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, Buffer.from(message), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

function normalizeAddress(address: string): string {
  return address.trim().toUpperCase();
}
