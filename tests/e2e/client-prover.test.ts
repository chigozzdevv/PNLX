import { describe, expect, test } from "bun:test";
import { fieldMerkleProof, hashFields } from "@merkl/crypto";
import { PRICE_SCALE } from "@merkl/market-math";
import { createCircuitMarginNote } from "@merkl/sdk";
import type { Hex } from "@merkl/protocol-types";
import { createLocalClientProverHandler } from "../../scripts/prover/local-client-prover";

function body(data: unknown): BodyInit {
  return JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

describe("local client prover", () => {
  test("generates deposit and intent proof bundles for client-side registration", async () => {
    const handle = createLocalClientProverHandler(process.cwd());
    const note = createCircuitMarginNote({
      amount: 12_000n,
      assetId: "usdc",
      blinding: "local-prover-blind",
      owner: "GLOCALPROVER",
      rho: "local-prover-rho",
      spendSecret: "local-prover-spend",
    });

    const depositResponse = await handle(
      new Request("http://127.0.0.1:4101/deposit-note", {
        method: "POST",
        body: body({
          amount: note.amount,
          blinding: note.blinding,
          commitment: note.commitment,
          ownerDigest: note.ownerDigest,
          rhoDigest: note.rhoDigest,
          tokenDigest: note.assetDigest,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(depositResponse.status).toBe(200);
    const deposit = await depositResponse.json() as Record<string, Record<string, unknown>>;
    expect((deposit.record as Record<string, unknown>).commitment).toBe(note.commitment);
    expect(typeof (deposit.artifact as Record<string, unknown>).proofBase64).toBe("string");

    const membership = fieldMerkleProof([note.commitment as Hex], note.commitment as Hex);
    const intentResponse = await handle(
      new Request("http://127.0.0.1:4101/intent-validity", {
        method: "POST",
        body: body({
          assetDigest: note.assetDigest,
          batchId: "local-prover-batch",
          blinding: note.blinding,
          currentBatch: 1n,
          expiryBatch: 2n,
          limitPrice: 50_000n * PRICE_SCALE,
          margin: 12_000n,
          marginRoot: membership.root,
          marketId: "btc-usd-perp",
          nonce: "local-prover-nonce",
          noteAmount: note.amount,
          noteCommitment: note.commitment,
          noteNullifier: note.noteNullifier,
          owner: "GLOCALPROVER",
          ownerDigest: note.ownerDigest,
          pathIndices: membership.indices,
          pathSiblings: membership.siblings,
          rhoDigest: note.rhoDigest,
          salt: "local-prover-salt",
          side: "long",
          size: 1n,
          spendSecretDigest: note.spendSecretDigest,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(intentResponse.status).toBe(200);
    const intent = await intentResponse.json() as Record<string, Record<string, unknown>>;
    const record = intent.record as Record<string, unknown>;
    const artifact = intent.artifact as Record<string, unknown>;
    expect(record.noteCommitment).toBe(note.commitment);
    expect(record.noteNullifier).toBe(note.noteNullifier);
    expect(typeof artifact.proofBase64).toBe("string");
    expect(JSON.stringify(intent)).not.toContain("local-prover-spend");

    const badResponse = await handle(
      new Request("http://127.0.0.1:4101/deposit-note", {
        method: "POST",
        body: body({
          amount: note.amount,
          blinding: hashFields("bad", ["blinding"]),
          commitment: note.commitment,
          ownerDigest: note.ownerDigest,
          rhoDigest: note.rhoDigest,
          tokenDigest: note.assetDigest,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(badResponse.status).toBe(500);
  });
});
