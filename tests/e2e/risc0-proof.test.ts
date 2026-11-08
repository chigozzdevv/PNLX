import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { assertBatchSettlementCapacity, readBatchSettlementCapacity } from "@/shared/protocol/batch-settlement-proof";
import {
  RISC0_GROTH16_SEAL_BYTES,
  RISC0_BATCH_MATCH_IMAGE_ID,
  assertRisc0DeploymentImageId,
  defaultProverRunner,
  runLocalProver,
  runRunpodProver,
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
      ownerDigest: hashFields("fixture-owner-digest", [index]),
      positionSeed: hashFields("fixture-position-seed", [index]),
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
    const settlement = { orderUpdates: [], newCommitments: [], marginChangeCommitments: [], spentNullifiers: [], makerIntents: [], takerIntents: [] };
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
  test("rejects an outdated deployment image before requesting a proof", () => {
    const root = mkdtempSync(join(tmpdir(), "pnlx-risc0-deployment-"));
    mkdirSync(join(root, "deployments"));
    const path = join(root, "deployments", "testnet.json");
    writeFileSync(path, JSON.stringify({ risc0BatchMatchImageId: RISC0_BATCH_MATCH_IMAGE_ID }));
    expect(() => assertRisc0DeploymentImageId(root)).not.toThrow();

    writeFileSync(path, JSON.stringify({ risc0BatchMatchImageId: `0x${"ff".repeat(32)}` }));
    expect(() => assertRisc0DeploymentImageId(root)).toThrow("RISC0 deployment image id mismatch");
  });

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

  test("selects the prover backend from configuration", () => {
    const saved = {
      backend: process.env.PNLX_PROVER_BACKEND,
      apiKey: process.env.RUNPOD_API_KEY,
      endpoint: process.env.RUNPOD_ENDPOINT_ID,
    };
    try {
      delete process.env.PNLX_PROVER_BACKEND;
      delete process.env.RUNPOD_API_KEY;
      delete process.env.RUNPOD_ENDPOINT_ID;
      expect(defaultProverRunner()).toBe(runLocalProver);

      process.env.RUNPOD_API_KEY = "test-key";
      process.env.RUNPOD_ENDPOINT_ID = "test-endpoint";
      expect(defaultProverRunner().name).toContain("runRunpodProver");

      process.env.PNLX_PROVER_BACKEND = "local";
      expect(defaultProverRunner()).toBe(runLocalProver);

      process.env.PNLX_PROVER_BACKEND = "unexpected";
      expect(() => defaultProverRunner()).toThrow("PNLX_PROVER_BACKEND=unexpected is not supported");

      delete process.env.RUNPOD_API_KEY;
      process.env.PNLX_PROVER_BACKEND = "runpod";
      expect(() => defaultProverRunner()).toThrow("RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID are required");
    } finally {
      for (const [key, value] of Object.entries({
        PNLX_PROVER_BACKEND: saved.backend,
        RUNPOD_API_KEY: saved.apiKey,
        RUNPOD_ENDPOINT_ID: saved.endpoint,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  async function withRunpodEnv(work: () => Promise<void> | void): Promise<void> {
    const saved = { apiKey: process.env.RUNPOD_API_KEY, endpoint: process.env.RUNPOD_ENDPOINT_ID };
    process.env.RUNPOD_API_KEY = "test-key";
    process.env.RUNPOD_ENDPOINT_ID = "test-endpoint";
    try { await work(); }
    finally {
      if (saved.apiKey === undefined) delete process.env.RUNPOD_API_KEY;
      else process.env.RUNPOD_API_KEY = saved.apiKey;
      if (saved.endpoint === undefined) delete process.env.RUNPOD_ENDPOINT_ID;
      else process.env.RUNPOD_ENDPOINT_ID = saved.endpoint;
    }
  }

  test("the runpod prover wraps the returned receipt into the artifact contract", async () => {
    await withRunpodEnv(async () => {
      const proofDir = mkdtempSync(join(tmpdir(), "pnlx-risc0-runpod-"));
      writeFileSync(join(proofDir, "input.json"), "{}");
      const journal = Buffer.from("batch journal bytes");
      const receipt = Buffer.from(JSON.stringify({ succinct: true }));
      const seal = Buffer.alloc(RISC0_GROTH16_SEAL_BYTES);
      seal.set(Buffer.from(SELECTOR, "hex"), 0);
      seal[seal.length - 1] = 1;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/runsync")) {
          return new Response(JSON.stringify({ id: "job-1", status: "IN_PROGRESS" }), { status: 200 });
        }
        return new Response(JSON.stringify({
          id: "job-1",
          status: "COMPLETED",
          output: {
            journal_b64: journal.toString("base64"),
            journal_digest: `0x${createHash("sha256").update(journal).digest("hex")}`,
            receipt_b64: receipt.toString("base64"),
            receipt_digest: `0x${createHash("sha256").update(receipt).digest("hex")}`,
            image_id: RISC0_BATCH_MATCH_IMAGE_ID,
          },
        }), { status: 200 });
      }) as unknown as typeof fetch;
      // The local CPU wrap is faked with a script that writes the same
      // artifact contract the real --wrap mode emits.
      const wrapScript = `
        const fs = require("node:fs");
        const dir = ${JSON.stringify(proofDir)};
        const imageId = ${JSON.stringify(RISC0_BATCH_MATCH_IMAGE_ID)};
        const journal = Buffer.from(${JSON.stringify(journal.toString("base64"))}, "base64");
        const seal = Buffer.alloc(260, 1);
        Buffer.from("73c457ba", "hex").copy(seal);
        fs.writeFileSync(dir + "/journal.bin", journal);
        fs.writeFileSync(dir + "/seal.bin", seal);
        const metadata = {
          image_id: imageId,
          journal_digest: "0x" + require("node:crypto").createHash("sha256").update(journal).digest("hex"),
          journal_path: dir + "/journal.bin",
          seal_digest: "0x" + require("node:crypto").createHash("sha256").update(seal).digest("hex"),
          seal_path: dir + "/seal.bin",
        };
        fs.writeFileSync(dir + "/proof.json", JSON.stringify(metadata, null, 2) + "\\n");
      `;
      try {
        const result = await runRunpodProver(".", join(proofDir, "input.json"), proofDir, {
          wrapCommand: { command: process.execPath, args: ["-e", wrapScript] },
        });
        expect(result.status).toBe(0);
        const metadata = JSON.parse(readFileSync(join(proofDir, "proof.json"), "utf8"));
        expect(metadata.image_id).toBe(RISC0_BATCH_MATCH_IMAGE_ID);
        expect(metadata.seal_path).toBe(join(proofDir, "seal.bin"));
        expect(metadata.journal_path).toBe(join(proofDir, "journal.bin"));
        expect(metadata.prover_job_id).toBe("job-1");
        expect(new Uint8Array(readFileSync(join(proofDir, "receipt.json")))).toEqual(new Uint8Array(receipt));
        expect(() => validateRisc0Seal(readFileSync(join(proofDir, "seal.bin")), SELECTOR)).not.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(proofDir, { recursive: true, force: true });
      }
    });
  });

  test("a failed runpod job surfaces as a failed prover run", async () => {
    await withRunpodEnv(async () => {
      const proofDir = mkdtempSync(join(tmpdir(), "pnlx-risc0-runpod-failed-"));
      writeFileSync(join(proofDir, "input.json"), "{}");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(JSON.stringify({
        id: "job-2", status: "FAILED",
      }), { status: 200 })) as unknown as typeof fetch;
      try {
        const result = await runRunpodProver(".", join(proofDir, "input.json"), proofDir);
        expect(result.status).toBe(1);
        expect(result.error).toBe("RunPod prover failed");
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(proofDir, { recursive: true, force: true });
      }
    });
  });

  test("a runpod job that never completes honors the prover deadline", async () => {
    await withRunpodEnv(async () => {
      const proofDir = mkdtempSync(join(tmpdir(), "pnlx-risc0-runpod-deadline-"));
      writeFileSync(join(proofDir, "input.json"), "{}");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(JSON.stringify({
        id: "job-3", status: "IN_QUEUE",
      }), { status: 200 })) as unknown as typeof fetch;
      try {
        const result = await runRunpodProver(".", join(proofDir, "input.json"), proofDir, { timeoutMs: 1 });
        expect(result.status).toBe(1);
        expect(result.error).toBe("prover deadline exceeded");
      } finally {
        globalThis.fetch = originalFetch;
        rmSync(proofDir, { recursive: true, force: true });
      }
    });
  });

  test("the runpod prover requires endpoint configuration", async () => {
    const saved = { apiKey: process.env.RUNPOD_API_KEY, endpoint: process.env.RUNPOD_ENDPOINT_ID };
    try {
      delete process.env.RUNPOD_API_KEY;
      delete process.env.RUNPOD_ENDPOINT_ID;
      expect(() => runRunpodProver(".", "unused", "unused")).toThrow(
        "RUNPOD_ENDPOINT_ID and RUNPOD_API_KEY are required",
      );
    } finally {
      if (saved.apiKey === undefined) delete process.env.RUNPOD_API_KEY;
      else process.env.RUNPOD_API_KEY = saved.apiKey;
      if (saved.endpoint === undefined) delete process.env.RUNPOD_ENDPOINT_ID;
      else process.env.RUNPOD_ENDPOINT_ID = saved.endpoint;
    }
  });
});

test("rejects a two-execution proof before deployment checks, witness files, or paid proving", async () => {
  const root = mkdtempSync(join(tmpdir(), "pnlx-budget-before-proving-"));
  const market = { marketId: "budget", fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };
  const intents = [1n, 1n, -1n, -1n].map((signedSize, index) => ({
    batchId: "budget", marketId: market.marketId, signedSize, limitPrice: 100_000_000n, margin: 100n,
    noteChangeCommitment: "0x0" as const, noteNullifier: hashFields("budget-nullifier", [index]),
    intentCommitment: hashFields("budget-intent", [index]), ownerCommitment: hashFields("budget-owner", [index]),
    ownerDigest: hashFields("budget-owner-field", [index]), positionSeed: hashFields("budget-seed", [index]),
  }));
  const match = new BatchMatcherService().match({ batchId: "budget", intents, market });
  expect(match.executions).toHaveLength(2);
  expect(match.fills).toHaveLength(4);
  try {
    await expect(createRisc0BatchSettlement({ batchId: "budget", intents, market, match }, root))
      .rejects.toThrow("batch relay budget supports at most 1 matched execution");
    expect(existsSync(join(root, ".pnlx"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
