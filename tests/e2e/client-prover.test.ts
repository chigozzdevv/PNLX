import { describe, expect, test } from "bun:test";
import { fieldMerkleProof, fieldMerkleRoot, hashFields } from "@pnlx/crypto";
import { PRICE_SCALE, settleClose } from "@pnlx/market-math";
import { createCircuitMarginNote, createCircuitPositionNote } from "@pnlx/sdk";
import type { Hex } from "@pnlx/protocol-types";
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

  test("generates position close proof bundles for client-side closes", async () => {
    const handle = createLocalClientProverHandler(process.cwd());
    const owner = hashFields("owner", ["local-close-owner"]);
    const position = createCircuitPositionNote({
      blinding: "local-close-position-blind",
      entryPrice: 50_000n * PRICE_SCALE,
      fundingIndex: 0n,
      margin: 12_000n,
      marketId: "btc-usd-perp",
      owner,
      rho: "local-close-position-rho",
      side: "long",
      size: 1n,
      spendSecret: "local-close-position-spend",
    });
    const positionCommitment = position.commitment as Hex;
    const membership = fieldMerkleProof([positionCommitment], positionCommitment);
    const closeSettlement = settleClose({
      closeSize: 1n,
      entryPrice: 50_000n * PRICE_SCALE,
      fee: 0n,
      fundingPayment: 0n,
      margin: 12_000n,
      markPrice: 51_000n * PRICE_SCALE,
      side: "long",
    });
    const closedPosition = createCircuitPositionNote({
      blinding: "local-close-new-position-blind",
      entryPrice: 50_000n * PRICE_SCALE,
      fundingIndex: 0n,
      margin: 0n,
      marketId: "btc-usd-perp",
      owner,
      rho: "local-close-new-position-rho",
      side: "long",
      size: 0n,
      spendSecret: "local-close-new-position-spend",
    });
    const marginOutput = createCircuitMarginNote({
      amount: closeSettlement.newMargin,
      assetId: "usdc",
      blinding: "local-close-margin-blind",
      owner,
      rho: "local-close-margin-rho",
      spendSecret: "local-close-margin-spend",
    });
    const response = await handle(
      new Request("http://127.0.0.1:4101/position-close", {
        method: "POST",
        body: body({
          blinding: position.blinding,
          closeCommitment: hashFields("manual-position-close", ["local-close"]),
          closeSize: 1n,
          entryPrice: 50_000n * PRICE_SCALE,
          fee: 0n,
          fundingIndex: 0n,
          fundingPayment: 0n,
          margin: 12_000n,
          marginOutputAmount: closeSettlement.newMargin,
          marginOutputAssetDigest: marginOutput.assetDigest,
          marginOutputBlinding: marginOutput.blinding,
          marginOutputCommitment: marginOutput.commitment,
          marginOutputRhoDigest: marginOutput.rhoDigest,
          marketDigest: position.marketDigest,
          marketId: "btc-usd-perp",
          markPrice: 51_000n * PRICE_SCALE,
          newMargin: closeSettlement.newMargin,
          newPositionBlinding: closedPosition.blinding,
          newPositionCommitment: closedPosition.commitment,
          newPositionRhoDigest: closedPosition.rhoDigest,
          newPositionRoot: fieldMerkleRoot([positionCommitment, closedPosition.commitment as Hex]),
          ownerDigest: position.ownerDigest,
          pathIndices: membership.indices,
          pathSiblings: membership.siblings,
          positionCommitment,
          positionNullifier: position.positionNullifier,
          positionRoot: membership.root,
          remainingMargin: 0n,
          rhoDigest: position.rhoDigest,
          side: "long",
          size: 1n,
          spendSecretDigest: position.spendSecretDigest,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    const close = await response.json() as Record<string, Record<string, unknown>>;
    expect((close.record as Record<string, unknown>).positionCommitment).toBe(positionCommitment);
    expect(typeof (close.artifact as Record<string, unknown>).proofBase64).toBe("string");
    expect(JSON.stringify(close)).not.toContain("local-close-position-spend");
  });
});
