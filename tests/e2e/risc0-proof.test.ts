import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  RISC0_GROTH16_SEAL_BYTES,
  resumableBoundlessRequest,
  risc0ProofMetadataReady,
  validateRisc0Seal,
} from "@/workers/risc0-matcher/risc0-proof";

const SELECTOR = "73c457ba";

describe("RISC0 Groth16 proof artifacts", () => {
  test("accepts a correctly sized seal with the deployed selector", () => {
    const seal = new Uint8Array(RISC0_GROTH16_SEAL_BYTES);
    seal.set(Buffer.from(SELECTOR, "hex"), 0);
    seal[seal.length - 1] = 1;
    expect(() => validateRisc0Seal(seal, SELECTOR)).not.toThrow();
  });

  test("rejects the cached 32-byte zero seal", () => {
    expect(() => validateRisc0Seal(new Uint8Array(32), SELECTOR)).toThrow(
      "must be 260 bytes; received 32",
    );
  });

  test("rejects a seal for a different verifier selector", () => {
    const seal = new Uint8Array(RISC0_GROTH16_SEAL_BYTES);
    seal.set(Buffer.from("00000001", "hex"), 0);
    expect(() => validateRisc0Seal(seal, SELECTOR)).toThrow(
      "seal selector mismatch",
    );
  });

  test("recognizes completed proof artifacts without waiting for the prover process to exit", () => {
    const proofDir = mkdtempSync(join(tmpdir(), "pnlx-risc0-ready-"));
    const journalPath = join(proofDir, "journal.bin");
    const sealPath = join(proofDir, "seal.bin");
    const metadataPath = join(proofDir, "proof.json");

    writeFileSync(metadataPath, JSON.stringify({ journal_path: journalPath, seal_path: sealPath }));
    expect(risc0ProofMetadataReady(metadataPath)).toBe(false);

    writeFileSync(journalPath, "journal");
    writeFileSync(sealPath, "seal");
    expect(risc0ProofMetadataReady(metadataPath)).toBe(true);
  });

  test("resumes only unexpired Boundless requests", () => {
    const proofDir = mkdtempSync(join(tmpdir(), "pnlx-risc0-request-"));
    const requestPath = join(proofDir, "request.json");
    const requestId = `0x${"12".repeat(32)}`;
    const now = Math.floor(Date.now() / 1_000);

    writeFileSync(requestPath, JSON.stringify({ expires_at: now + 60, request_id: requestId }));
    expect(resumableBoundlessRequest(requestPath)).toEqual({
      expiresAt: now + 60,
      requestId,
    });

    writeFileSync(requestPath, JSON.stringify({ expires_at: now - 1, request_id: requestId }));
    expect(resumableBoundlessRequest(requestPath)).toBeUndefined();
  });
});
