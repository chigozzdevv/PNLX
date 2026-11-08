import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import type { Hex, PrivateMatchIntent } from "@pnlx/protocol-types";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { prepareRisc0SettlementDraft, RISC0_BATCH_MATCH_IMAGE_ID, runLocalProver, runRisc0Prover } from "@/workers/risc0-matcher/risc0-proof";

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
  test("different entry funding epochs cannot coalesce into one in-flight proof", async () => {
    await withFixture(async (f) => {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const first = runRisc0Prover(f.root, f.input, f.draft, async () => {
        entered();
        await pending;
        f.output();
        return { metadataPath: f.metadataPath, status: 0, stdout: "", stderr: "" };
      });
      try {
        await started;
        const market = { ...f.input.market, fundingIndex: -7n };
        const input = { ...f.input, market, match: new BatchMatcherService().match({ ...f.input, market }) };
        await expect(runRisc0Prover(f.root, input, prepareRisc0SettlementDraft(input)))
          .rejects.toThrow("conflicting prover witness");
      } finally { release(); await first; }
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
        runLocalProver(root, inputPath, proofDir, {
          timeoutMs: 50, command: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] },
        }))).rejects.toThrow("prover deadline exceeded");
      expect(Date.now() - start).toBeLessThan(2000);
      expect(existsSync(f.inputPath)).toBe(false);
    });
  });
});

describe("prover slot gate", () => {
  test("serializes concurrent prover runs until the active run releases", async () => {
    await withControlledHosts(async (createHost) => {
      const first = createHost("first"), second = createHost("second");
      first.start(); second.start();
      await waitForFile(first.started);
      await Bun.sleep(300);
      expect(existsSync(second.started)).toBe(false);
      first.stop();
      expect((await first.result()).status).toBe(0);
      await waitForFile(second.started);
      second.stop();
      expect((await second.result()).status).toBe(0);
    });
  });

  for (const outcome of ["failure", "timeout", "throw"] as const) {
    test(`a ${outcome} releases the next prover run`, async () => {
      await withControlledHosts(async (createHost) => {
        const first = createHost("first", { outcome });
        const second = createHost("second");
        first.start(); second.start();
        const failed = await first.result().then((result) => result, () => undefined);
        if (outcome === "failure") expect(failed?.status).toBe(7);
        if (outcome === "timeout") expect(failed?.error).toBe("prover deadline exceeded");
        if (outcome === "throw") expect(failed).toBeUndefined();
        await waitForFile(second.started);
        second.stop(); expect((await second.result()).status).toBe(0);
      });
    });
  }

  test("invalid deadlines still throw before a prover is queued", () => {
    expect(() => runLocalProver(".", "unused", "unused", { timeoutMs: 0 })).toThrow("invalid RISC0 prover deadline");
  });
});

type ControlledHostOptions = { outcome?: "failure" | "timeout" | "throw" };

async function withControlledHosts(work: (createHost: (name: string, options?: ControlledHostOptions) => {
  started: string; stop(): void; start(): void; result(): ReturnType<typeof runLocalProver>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pnlx-prover-slot-"));
  const runs: ReturnType<typeof runLocalProver>[] = [];
  const stops: Array<() => void> = [];
  const createHost = (name: string, options: ControlledHostOptions = {}) => {
    const directory = join(root, name);
    mkdirSync(directory);
    const started = join(directory, "started.json"), exit = join(directory, "exit");
    const script = `const fs=require("node:fs");
      fs.writeFileSync(${JSON.stringify(started)},JSON.stringify({pid:process.pid}));
      ${options.outcome === "failure" ? "process.exit(7);" : ""}
      setInterval(()=>{
        if(fs.existsSync(${JSON.stringify(exit)}))process.exit(0);
      },10);`;
    let run: ReturnType<typeof runLocalProver>;
    const stop = () => writeFileSync(exit, "stop");
    stops.push(stop);
    return {
      started, stop,
      start() {
        // Separate roots still share the process-wide prover slot gate.
        run = runLocalProver(directory, join(directory, "input.json"), directory, {
          timeoutMs: options.outcome === "timeout" ? 100 : 3_000,
          command: { command: options.outcome === "throw" ? "" : process.execPath, args: ["-e", script] },
        });
        runs.push(run);
        void run.catch(() => {});
      },
      result: () => run,
    };
  };
  try { await work(createHost); }
  finally {
    stops.forEach((stop) => stop());
    await Promise.allSettled(runs);
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fake prover");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
