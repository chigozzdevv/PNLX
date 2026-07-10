import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { hashFields } from "@pnlx/crypto";
import type { ProofArtifact } from "@pnlx/proof-system";
import type { BatchSettlement, Hex, ProofMeta } from "@pnlx/protocol-types";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";
import { matchTranscriptDigest } from "@/workers/batch-matcher/match-transcript";
import type { SettlementProof, SettlementProofInput } from "@/workers/proof-coordinator/proof-coordinator.model";

export const RISC0_BATCH_MATCH_CIRCUIT_ID = "batch-match";
export const RISC0_GROTH16_SEAL_BYTES = 260;
export const RISC0_BATCH_MATCH_IMAGE_ID = batchMatchImageId();
export const RISC0_BATCH_MATCH_CIRCUIT_KEY = hashFields("circuit-key", ["risc0-batch-match-v1"]);
export const RISC0_BATCH_MATCH_CIRCUIT_HASH = sourceHash("risc0/batch-match");
export const RISC0_STELLAR_VERIFIER_HASH = fileHash(
  "vendor/stellar-risc0-verifier/contracts/groth16-verifier/parameters.json",
);

interface Risc0ProverOutput {
  image_id: Hex;
  journal_digest: Hex;
  journal_path: string;
  seal_digest: Hex;
  seal_path: string;
}

interface ProverRun {
  error?: string;
  metadataPath: string;
  stderr: string;
  stdout: string;
  status: number | null;
}

export interface Risc0BatchSettlementResult {
  artifact: ProofArtifact;
  settlement: SettlementProof;
}

export function createRisc0BatchSettlement(
  input: SettlementProofInput,
  root = process.cwd(),
): Risc0BatchSettlementResult {
  assertMatchTranscript(input);

  const newCommitments = input.match.fills.map((fill) => fill.positionCommitment);
  const settlementDigest = risc0SettlementDigest(input, newCommitments);

  const draft = {
    aggregateVolume: input.match.aggregateVolume,
    batchId: input.batchId,
    fillCount: input.match.fills.length,
    matchTranscriptDigest: input.match.matchTranscriptDigest,
    marginChangeCommitments: input.match.marginChangeCommitments,
    marketId: input.market.marketId,
    newCommitments,
    newRoot: input.newRoot,
    oldRoot: input.oldRoot,
    openInterestDelta: input.match.openInterestDelta,
    orderUpdates: input.match.orderUpdates,
    residualSize: input.match.residualSize,
    settlementDigest,
    spentNullifiers: input.match.spentNullifiers,
  };

  const proverOutput = runRisc0Prover(root, input, draft);
  if (proverOutput.image_id !== RISC0_BATCH_MATCH_IMAGE_ID) {
    throw new Error(
      `RISC0 batch-match image id mismatch: expected ${RISC0_BATCH_MATCH_IMAGE_ID}, received ${proverOutput.image_id}`,
    );
  }
  const expectedJournalDigest = batchSettlementPublicInputHash({
    ...draft,
    proof: proofMeta({
      imageId: proverOutput.image_id,
      journalDigest: proverOutput.journal_digest,
      sealDigest: proverOutput.seal_digest,
    }),
  });
  if (proverOutput.journal_digest !== expectedJournalDigest) {
    throw new Error("RISC0 journal digest does not match batch settlement public input hash");
  }

  const proof = proofMeta({
    imageId: proverOutput.image_id,
    journalDigest: proverOutput.journal_digest,
    sealDigest: proverOutput.seal_digest,
  });
  const artifact: ProofArtifact = {
    circuitId: RISC0_BATCH_MATCH_CIRCUIT_ID,
    circuitKey: RISC0_BATCH_MATCH_CIRCUIT_KEY,
    bytecodeHash: RISC0_BATCH_MATCH_CIRCUIT_HASH,
    proofHash: proverOutput.seal_digest,
    proofPath: proverOutput.seal_path,
    publicInputsHash: proverOutput.journal_digest,
    publicInputsPath: proverOutput.journal_path,
    vkHash: RISC0_STELLAR_VERIFIER_HASH,
    vkPath: join(root, "vendor/stellar-risc0-verifier/contracts/groth16-verifier/parameters.json"),
    witnessHash: inputHash(input),
  };

  return {
    artifact,
    settlement: {
      ...draft,
      proof,
    },
  };
}

function proofMeta(receipt: { imageId: Hex; journalDigest: Hex; sealDigest: Hex }): ProofMeta {
  return {
    circuitHash: RISC0_BATCH_MATCH_CIRCUIT_HASH,
    circuitId: RISC0_BATCH_MATCH_CIRCUIT_ID,
    circuitKey: RISC0_BATCH_MATCH_CIRCUIT_KEY,
    imageId: receipt.imageId,
    journalDigest: receipt.journalDigest,
    proofDigest: receipt.sealDigest,
    proofSystem: "risc0-groth16",
    publicInputHash: receipt.journalDigest,
    sealDigest: receipt.sealDigest,
    verifierHash: RISC0_STELLAR_VERIFIER_HASH,
  };
}

function risc0SettlementDigest(input: SettlementProofInput, newCommitments: Hex[]): Hex {
  return hashFields("risc0-settlement", [
    input.batchId,
    input.market.marketId,
    normalizeHex(input.oldRoot),
    normalizeHex(input.newRoot),
    input.match.matchTranscriptDigest,
    input.match.orderUpdates.map((update) => {
      const normalized: {
        intentCommitment: Hex;
        residualCommitment?: Hex;
        status: string;
      } = {
        intentCommitment: update.intentCommitment,
        status: update.status,
      };
      if (update.residualCommitment) normalized.residualCommitment = update.residualCommitment;
      return normalized;
    }),
    newCommitments,
    input.match.marginChangeCommitments,
    input.match.spentNullifiers,
    input.match.aggregateVolume,
    input.match.openInterestDelta,
    input.match.residualSize,
  ]);
}

function normalizeHex(value: Hex): Hex {
  if (value === "0x0") return value;
  return value.startsWith("0x") ? (`0x${value.slice(2).toLowerCase()}` as Hex) : value;
}

function runRisc0Prover(
  root: string,
  input: SettlementProofInput,
  draft: Omit<BatchSettlement, "proof">,
): Risc0ProverOutput {
  const proofDir = join(root, ".pnlx", "risc0", safeName(`${input.batchId}-${input.market.marketId}`));
  const inputPath = join(proofDir, "input.json");
  mkdirSync(proofDir, { recursive: true });
  writeFileSync(
    inputPath,
    `${JSON.stringify(toProverInput(input, draft), bigintReplacer, 2)}\n`,
  );

  const expectedSelector = expectedRisc0Selector(root);
  const cachedOutput = readRisc0ProverOutput(
    join(proofDir, "proof.json"),
    expectedSelector,
  );
  if (cachedOutput) return cachedOutput;

  const result = runBoundlessProver(root, inputPath, proofDir);
  if (result.status !== 0) {
    const output = [result.error, result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`Boundless RISC0 Groth16 batch prover failed\n${output}`);
  }

  const output = readRisc0ProverOutput(result.metadataPath, expectedSelector);
  if (!output) throw new Error(`RISC0 proof metadata was not written: ${result.metadataPath}`);
  return output;
}

function readRisc0ProverOutput(
  metadataPath: string,
  expectedSelector: string,
): Risc0ProverOutput | undefined {
  if (!existsSync(metadataPath)) return undefined;
  const output = JSON.parse(readFileSync(metadataPath, "utf8")) as Risc0ProverOutput;
  assertHex32(output.image_id, "RISC0 image id");
  assertHex32(output.journal_digest, "RISC0 journal digest");
  assertHex32(output.seal_digest, "RISC0 seal digest");
  if (!existsSync(output.seal_path)) throw new Error(`RISC0 seal was not written: ${output.seal_path}`);
  if (!existsSync(output.journal_path)) throw new Error(`RISC0 journal was not written: ${output.journal_path}`);
  validateRisc0Seal(readFileSync(output.seal_path), expectedSelector);
  if (sha256File(output.seal_path) !== output.seal_digest) throw new Error("RISC0 seal digest mismatch");
  if (sha256File(output.journal_path) !== output.journal_digest) throw new Error("RISC0 journal digest mismatch");
  return output;
}

export function validateRisc0Seal(seal: Uint8Array, expectedSelector: string): void {
  const selector = expectedSelector.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(selector) || selector === "00000000") {
    throw new Error("RISC0 Groth16 selector is not configured correctly");
  }
  if (seal.byteLength !== RISC0_GROTH16_SEAL_BYTES) {
    throw new Error(
      `RISC0 Groth16 seal must be ${RISC0_GROTH16_SEAL_BYTES} bytes; received ${seal.byteLength}`,
    );
  }
  const actualSelector = Buffer.from(seal.subarray(0, 4)).toString("hex");
  if (actualSelector !== selector) {
    throw new Error(
      `RISC0 Groth16 seal selector mismatch: expected ${selector}, received ${actualSelector}`,
    );
  }
  if (seal.every((value) => value === 0)) {
    throw new Error("RISC0 Groth16 seal cannot be all zero bytes");
  }
}

function expectedRisc0Selector(root: string): string {
  const deploymentPath = process.env.STELLAR_DEPLOYMENT_FILE || "deployments/testnet.json";
  const absolutePath = deploymentPath.startsWith("/") ? deploymentPath : join(root, deploymentPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`RISC0 deployment registry was not found: ${absolutePath}`);
  }
  const deployment = JSON.parse(readFileSync(absolutePath, "utf8")) as {
    risc0VerifierStack?: { selector?: unknown };
  };
  const selector = deployment.risc0VerifierStack?.selector;
  if (typeof selector !== "string") {
    throw new Error("RISC0 deployment registry is missing the Groth16 selector");
  }
  return selector;
}

function assertHex32(value: unknown, label: string): asserts value is Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32 hex`);
  }
}

function batchMatchImageId(): Hex {
  const path = join(process.cwd(), "risc0/batch-match/image-id.json");
  const value = JSON.parse(readFileSync(path, "utf8")) as { imageId?: unknown };
  assertHex32(value.imageId, "RISC0 batch-match image id");
  return value.imageId.toLowerCase() as Hex;
}

function runBoundlessProver(root: string, inputPath: string, proofDir: string): ProverRun {
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--release",
      "--manifest-path",
      join(root, "risc0/batch-match/host/Cargo.toml"),
      "--",
      inputPath,
      proofDir,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        BOUNDLESS_IGNORE_PREFLIGHT: process.env.BOUNDLESS_IGNORE_PREFLIGHT ?? "1",
        PATH: risc0ToolPath(process.env.HOME || "", process.env.PATH),
        RISC0_DEV_MODE: "0",
      },
    },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    error: result.error?.message,
    metadataPath: stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? join(proofDir, "proof.json"),
    stderr,
    stdout,
    status: result.status,
  };
}

function risc0ToolPath(home: string, existingPath = ""): string {
  return [
    home ? join(home, ".cargo", "bin") : "",
    existingPath,
  ].filter(Boolean).join(delimiter);
}

function toProverInput(input: SettlementProofInput, draft: Omit<BatchSettlement, "proof">) {
  return {
    batch_id: input.batchId,
    expected: {
      aggregate_volume: draft.aggregateVolume,
      batch_id: draft.batchId,
      fill_count: draft.fillCount,
      margin_change_commitments: draft.marginChangeCommitments,
      market_id: draft.marketId,
      match_transcript_digest: draft.matchTranscriptDigest,
      new_commitments: draft.newCommitments,
      new_root: draft.newRoot,
      old_root: draft.oldRoot,
      open_interest_delta: draft.openInterestDelta,
      order_updates: draft.orderUpdates.map((update) => ({
        intent_commitment: update.intentCommitment,
        residual_commitment: update.residualCommitment,
        status: update.status,
      })),
      residual_size: draft.residualSize,
      settlement_digest: draft.settlementDigest,
      spent_nullifiers: draft.spentNullifiers,
    },
    intents: input.intents.map((intent) => ({
      batch_id: intent.batchId,
      intent_commitment: intent.intentCommitment,
      limit_price: intent.limitPrice,
      margin: intent.margin,
      market_id: intent.marketId,
      note_change_commitment: intent.noteChangeCommitment,
      note_nullifier: intent.noteNullifier,
      owner_commitment: intent.ownerCommitment,
      signed_size: intent.signedSize,
      source_intent_commitment: intent.sourceIntentCommitment,
    })),
    market: {
      funding_index: input.market.fundingIndex,
      initial_margin_rate: input.market.initialMarginRate,
      market_id: input.market.marketId,
      max_leverage: input.market.maxLeverage,
    },
    new_root: input.newRoot,
    old_root: input.oldRoot,
    position_commitments: input.positionCommitments,
  };
}

function assertMatchTranscript(input: SettlementProofInput): void {
  const expected = matchTranscriptDigest(input.match);
  if (input.match.matchTranscriptDigest !== expected) {
    throw new Error("match transcript digest mismatch");
  }
}

function sourceHash(relativePath: string): Hex {
  const root = process.cwd();
  const base = join(root, relativePath);
  if (!existsSync(base)) throw new Error(`missing RISC0 source path: ${base}`);
  const hash = createHash("sha256");
  for (const path of walk(base)) {
    const relative = path.slice(base.length + 1);
    if (relative.startsWith("target/") || relative.includes("/target/")) continue;
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `0x${hash.digest("hex")}`;
}

function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory() && (entry.name === "target" || entry.name === ".git")) return [];
      if (entry.isDirectory()) return walk(child);
      return entry.isFile() ? [child] : [];
    })
    .sort();
}

function fileHash(relativePath: string): Hex {
  const path = join(process.cwd(), relativePath);
  if (!existsSync(path)) throw new Error(`missing RISC0 verifier parameter file: ${path}`);
  return sha256File(path);
}

function sha256File(path: string): Hex {
  return `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function inputHash(input: SettlementProofInput): Hex {
  return hashFields("risc0-batch-witness", [
    input.batchId,
    input.market.marketId,
    input.oldRoot,
    input.newRoot,
    input.positionCommitments,
    input.intents,
  ]);
}

function safeName(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return clean || "batch";
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
