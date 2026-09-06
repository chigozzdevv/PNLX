import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { assertBatchSettlementCapacity, readBatchSettlementCapacity } from "@/shared/protocol/batch-settlement-proof";
import {
  RISC0_GROTH16_SEAL_BYTES,
  resumableBoundlessRequest,
  risc0ProofMetadataReady,
  validateRisc0Seal,
  createRisc0BatchSettlement,
} from "@/workers/risc0-matcher/risc0-proof";

const SELECTOR = "73c457ba";

describe("batch capacity diagnostics", () => {
  test("stops a six-intent, ten-output batch before invoking the prover and preserves the actual breakdown", async () => {
    const market = {
      marketId: "capacity-test", fundingIndex: 0n, oraclePrice: 100_000_000n,
      initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n,
    };
    const sizes = [4n, 4n, 4n, -3n, -3n, -6n];
    const intents = sizes.map((signedSize, index) => ({
      batchId: "capacity-test", marketId: market.marketId,
      intentCommitment: hashFields("capacity-intent", [index]),
      noteNullifier: hashFields("capacity-nullifier", [index]),
      ownerCommitment: hashFields("capacity-owner", [index]),
      noteChangeCommitment: "0x0" as const,
      limitPrice: 100_000_000n,
      margin: (signedSize < 0n ? -signedSize : signedSize) * 100n,
      signedSize,
    }));
    const match = new BatchMatcherService().match({ batchId: "capacity-test", market, intents });
    let reason: string | undefined;
    try {
      await createRisc0BatchSettlement({ batchId: "capacity-test", market, intents, match }, "/private/tmp/no-capacity-test-prover");
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    expect(reason).toContain("batch proof supports at most 8 public items");
    // This is the string transport used by remote jobs and persisted failed runs.
    const transported = JSON.parse(JSON.stringify({ error: reason })).error;
    expect(readBatchSettlementCapacity(`proving: ${transported}`)).toEqual({
      limit: 8, filledIntents: 6, positionOutputs: 10,
      marginChangeOutputs: match.marginChangeCommitments.length,
      notesToSpend: 6, matchedExecutions: 5,
    });
  });

  test("checks every settlement list and accepts the exact eight-item boundary", () => {
    const settlement = { orderUpdates: [], newCommitments: [], marginChangeCommitments: [], spentNullifiers: [] };
    expect(() => assertBatchSettlementCapacity({ ...settlement, newCommitments: Array(8).fill("0x1") })).not.toThrow();
    for (const field of ["orderUpdates", "newCommitments", "marginChangeCommitments", "spentNullifiers"] as const) {
      expect(() => assertBatchSettlementCapacity({ ...settlement, [field]: Array(9).fill("0x1") })).toThrow("at most 8 public items");
    }
  });

  test("does not invent counts for legacy or malformed failure records", () => {
    expect(readBatchSettlementCapacity("batch proof supports at most 8 public items")).toBeUndefined();
    expect(readBatchSettlementCapacity("error; capacity={bad json}")).toBeUndefined();
    expect(readBatchSettlementCapacity('error; capacity={"limit":8,"filledIntents":6,"positionOutputs":-1,"marginChangeOutputs":0,"notesToSpend":6}')).toBeUndefined();
    expect(readBatchSettlementCapacity('error; capacity={"limit":8,"filledIntents":6,"positionOutputs":10,"marginChangeOutputs":0,"notesToSpend":6,"matchedExecutions":null}')).toBeUndefined();
  });
});

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
