import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import type { Hex, PrivateMatchIntent } from "@pnlx/protocol-types";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { prepareRisc0SettlementDraft, RISC0_BATCH_MATCH_IMAGE_ID, runBoundlessProver, runRisc0Prover } from "@/workers/risc0-matcher/risc0-proof";

const hash = (value: Uint8Array | string): Hex => `0x${createHash("sha256").update(value).digest("hex")}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pnlx-private-prover-"));
  const deployment = join(root, "deployment.json");
  writeFileSync(deployment, JSON.stringify({ risc0VerifierStack: { selector: "73c457ba" } }));
  const market = { marketId: "runtime", fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };
  const intents: PrivateMatchIntent[] = [1n, -1n].map((signedSize, index) => ({
    batchId: "runtime", marketId: "runtime", signedSize, limitPrice: 100_000_000n, margin: 100n,
    noteChangeCommitment: "0x0", intentCommitment: hashFields("runtime-intent", [index]),
    ownerCommitment: hashFields("runtime-owner", [index]), ownerDigest: hashFields("runtime-owner-field", [index]),
    positionSeed: hashFields("runtime-seed", [index]), noteNullifier: hashFields("runtime-note", [index]),
  }));
  const input = { batchId: "runtime", market, intents,
    match: new BatchMatcherService().match({ batchId: "runtime", market, intents }) };
  const proofDir = join(root, ".pnlx", "risc0", "runtime-runtime");
  const inputPath = join(proofDir, "input.json");
  const metadataPath = join(proofDir, "proof.json");
  const output = () => {
    mkdirSync(proofDir, { recursive: true });
    const seal = Buffer.alloc(260, 1);
    Buffer.from("73c457ba", "hex").copy(seal);
    const journal = Buffer.from("runtime artifact fixture; cryptographic verification is tested separately");
    const sealPath = join(proofDir, "seal.bin");
    const journalPath = join(proofDir, "journal.bin");
    writeFileSync(sealPath, seal);
    writeFileSync(journalPath, journal);
    writeFileSync(metadataPath, JSON.stringify({ image_id: RISC0_BATCH_MATCH_IMAGE_ID,
      journal_path: journalPath, journal_digest: hash(journal), seal_path: sealPath, seal_digest: hash(seal) }));
  };
  return { root, deployment, input, proofDir, inputPath, metadataPath, output, draft: prepareRisc0SettlementDraft(input) };
}

async function withFixture(work: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture();
  const previous = process.env.STELLAR_DEPLOYMENT_FILE;
  process.env.STELLAR_DEPLOYMENT_FILE = f.deployment;
  try { await work(f); }
  finally {
    if (previous === undefined) delete process.env.STELLAR_DEPLOYMENT_FILE;
    else process.env.STELLAR_DEPLOYMENT_FILE = previous;
    rmSync(f.root, { recursive: true, force: true });
  }
}

describe("RISC0 private witness lifecycle", () => {
  test("new Boundless requests force authenticated S3 despite public uploader settings", async () => {
    await withFixture(async (f) => {
      const previousUploader = process.env.STORAGE_UPLOADER;
      const previousForceCargo = process.env.PNLX_RISC0_FORCE_CARGO_RUN;
      const binary = join(f.root, "risc0/batch-match/target/release/pnlx-risc0-batch-match-prover");
      const launch = join(f.proofDir, "launch.json");
      mkdirSync(join(binary, ".."), { recursive: true });
      mkdirSync(f.proofDir, { recursive: true });
      writeFileSync(binary, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(launch)}, JSON.stringify(process.argv.slice(2)));\n`);
      chmodSync(binary, 0o700);
      process.env.STORAGE_UPLOADER = "pinata";
      process.env.PNLX_RISC0_FORCE_CARGO_RUN = "0";
      try {
        const result = await runBoundlessProver(f.root, f.inputPath, f.proofDir, { timeoutMs: 2_000 });
        expect(result.status).toBe(0);
        expect(JSON.parse(readFileSync(launch, "utf8"))).toEqual([
          f.inputPath, f.proofDir, "--storage-uploader", "s3", "--s3-presigned", "false", "--s3-public-url", "false",
        ]);
        writeFileSync(join(f.proofDir, "request.json"), JSON.stringify({ request_id: "0x1234", expires_at: Math.floor(Date.now() / 1000) + 60 }));
        const resumed = await runBoundlessProver(f.root, f.inputPath, f.proofDir, { timeoutMs: 2_000 });
        expect(resumed.status).toBe(0);
        expect(JSON.parse(readFileSync(launch, "utf8"))).toEqual([f.inputPath, f.proofDir, "--storage-uploader", "none"]);
      } finally {
        if (previousUploader === undefined) delete process.env.STORAGE_UPLOADER;
        else process.env.STORAGE_UPLOADER = previousUploader;
        if (previousForceCargo === undefined) delete process.env.PNLX_RISC0_FORCE_CARGO_RUN;
        else process.env.PNLX_RISC0_FORCE_CARGO_RUN = previousForceCargo;
      }
    });
  });

  test("cached artifacts never recreate input and remove an interrupted scratch file", async () => {
    await withFixture(async (f) => {
      f.output();
      writeFileSync(f.inputPath, "stale private witness");
      await runRisc0Prover(f.root, f.input, f.draft, async () => { throw new Error("cache must not run prover"); });
      expect(existsSync(f.inputPath)).toBe(false);
      expect(statSync(f.proofDir).mode & 0o777).toBe(0o700);
    });
  });

  test("input has restricted permissions during proving and is removed on success", async () => {
    await withFixture(async (f) => {
      await runRisc0Prover(f.root, f.input, f.draft, async (_root, inputPath) => {
        expect(statSync(inputPath).mode & 0o777).toBe(0o600);
        expect(statSync(f.proofDir).mode & 0o777).toBe(0o700);
        expect(JSON.parse(readFileSync(inputPath, "utf8")).intents[0].position_seed).toBe(f.input.intents[0]!.positionSeed);
        f.output();
        return { metadataPath: f.metadataPath, status: 0, stdout: "", stderr: "" };
      });
      expect(existsSync(f.inputPath)).toBe(false);
      expect(existsSync(f.metadataPath)).toBe(true);
    });
  });

  test("failure removes input and never relays witness-bearing child output", async () => {
    await withFixture(async (f) => {
      const secret = "PRIVATE-WITNESS-MUST-NOT-LEAVE-WORKER";
      let message = "";
      try {
        await runRisc0Prover(f.root, f.input, f.draft, async () => ({
          metadataPath: f.metadataPath, status: 1, stdout: secret, stderr: secret,
        }));
      } catch (error) { message = (error as Error).message; }
      expect(message).toContain("prover execution failed");
      expect(message).not.toContain(secret);
      expect(existsSync(f.inputPath)).toBe(false);
    });
  });

  test("a non-exiting prover is terminated at its deadline and leaves no input", async () => {
    await withFixture(async (f) => {
      const start = Date.now();
      await expect(runRisc0Prover(f.root, f.input, f.draft, (root, inputPath, proofDir) =>
        runBoundlessProver(root, inputPath, proofDir, {
          timeoutMs: 50, command: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
        }))).rejects.toThrow("prover deadline exceeded");
      expect(Date.now() - start).toBeLessThan(2000);
      expect(existsSync(f.inputPath)).toBe(false);
    });
  });
});
