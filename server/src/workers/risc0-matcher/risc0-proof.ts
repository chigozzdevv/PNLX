import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashFields } from "@pnlx/crypto";
import type { ProofArtifact } from "@pnlx/proof-system";
import type { BatchSettlement, Hex, ProofMeta } from "@pnlx/protocol-types";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";
import { matchTranscriptDigest } from "@/workers/batch-matcher/match-transcript";
import type { SettlementProof, SettlementProofInput } from "@/workers/proof-coordinator/proof-coordinator.model";

export const RISC0_BATCH_MATCH_CIRCUIT_ID = "batch-match";
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
  const settlementDigest = hashFields("risc0-settlement", [
    input.batchId,
    input.market.marketId,
    input.oldRoot,
    input.newRoot,
    input.match.matchTranscriptDigest,
    input.match.orderUpdates,
    newCommitments,
    input.match.marginChangeCommitments,
    input.match.spentNullifiers,
    input.match.aggregateVolume,
    input.match.openInterestDelta,
    input.match.residualSize,
  ]);

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

  const result = runLocalProver(root, inputPath, proofDir);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`RISC0 Groth16 batch prover failed\n${output}`);
  }

  const output = JSON.parse(readFileSync(result.metadataPath, "utf8")) as Risc0ProverOutput;
  if (!existsSync(output.seal_path)) throw new Error(`RISC0 seal was not written: ${output.seal_path}`);
  if (!existsSync(output.journal_path)) throw new Error(`RISC0 journal was not written: ${output.journal_path}`);
  if (sha256File(output.seal_path) !== output.seal_digest) throw new Error("RISC0 seal digest mismatch");
  if (sha256File(output.journal_path) !== output.journal_digest) throw new Error("RISC0 journal digest mismatch");
  return output;
}

function runLocalProver(root: string, inputPath: string, proofDir: string): ProverRun {
  assertGroth16ProverHost();
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
        RISC0_DEV_MODE: "0",
      },
    },
  );
  return {
    metadataPath: result.stdout.trim().split(/\r?\n/).at(-1) ?? join(proofDir, "proof.json"),
    stderr: result.stderr,
    stdout: result.stdout,
    status: result.status,
  };
}

function assertGroth16ProverHost(): void {
  if (process.arch === "x64") return;
  throw new Error(
    [
      "RISC0 Groth16 proof generation must run on an x86_64 prover host.",
      `Current host architecture is ${process.arch}.`,
      "RISC Zero's local-proving docs state that Groth16 proving is x86-only and Apple Silicon is unsupported, even via Docker.",
      "Run this prover on an x86_64 Linux machine, VM, CI runner, or dedicated private prover service.",
    ].join(" "),
  );
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
