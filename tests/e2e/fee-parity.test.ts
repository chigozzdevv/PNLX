import { createDecipheriv, createECDH, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import type { BatchSettlement, PrivateMatchIntent } from "@pnlx/protocol-types";
import { recoverPositionOpeningEventsForOwner } from "@/features/account-keys/account-key-recovery";
import { ProtocolStore } from "@/shared/state/store";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { prepareRisc0SettlementDraft, toProverInput } from "@/workers/risc0-matcher/risc0-proof";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";

function feeMatchInput() {
  const market = {
    marketId: "xlm-usd-perp", fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n,
  };
  const intents = [1n, -1n].map((side, index) => ({
    batchId: "fee-parity", marketId: market.marketId,
    intentCommitment: hashFields("intent", [index + 1]),
    noteNullifier: hashFields("nullifier", [index + 1]),
    ownerCommitment: hashFields("owner", [index + 1]),
    noteChangeCommitment: "0x0" as const,
    limitPrice: 100_000_000n,
    margin: 200_000_000n,
    signedSize: side * 1_000_000_000n,
  }));
  return {
    batchId: "fee-parity", market, intents,
    match: new BatchMatcherService().match({ batchId: "fee-parity", market, intents }),
  };
}

test("TypeScript matcher request agrees with the Rust proof fixture", () => {
  const input = feeMatchInput();
  const request = toProverInput(input, prepareRisc0SettlementDraft(input));
  const fixture = JSON.parse(readFileSync(join(process.cwd(),
    "risc0/batch-match/core/tests/fixtures/fee-match.json"), "utf8"));
  expect(JSON.parse(JSON.stringify(request, (_, value) =>
    typeof value === "bigint" ? value.toString() : value))).toEqual(fixture);
});

test("partial-fill proof binds the exact residual margin across TypeScript and Rust", () => {
  const input = feeMatchInput();
  input.batchId = "partial-preflight";
  input.intents[0].batchId = input.batchId;
  input.intents[1].batchId = input.batchId;
  input.intents[0].signedSize = 1_500_000_000n;
  input.intents[0].margin = 300_000_000n;
  input.match = new BatchMatcherService().match(input);
  const draft = prepareRisc0SettlementDraft(input);
  const request = toProverInput(input, draft);
  const fixture = JSON.parse(readFileSync(join(process.cwd(),
    "risc0/batch-match/core/tests/fixtures/partial-match.json"), "utf8"));
  expect(JSON.parse(JSON.stringify(request, (_, value) =>
    typeof value === "bigint" ? value.toString() : value))).toEqual(fixture);
  expect(request.expected.residual_margins).toEqual(["100000000", "0"]);
  expect(batchSettlementPublicInputHash(draft as BatchSettlement))
    .toBe("0xd8c7190d1f2ab9c3cbb4d4ad8c5063c77d9e88f05dc867757e2a0974bdd4f7ad");
});

test("recovered private position openings preserve each side's fee", () => {
  const input = feeMatchInput();
  const draft = prepareRisc0SettlementDraft(input);
  const store = new ProtocolStore();
  const settlement = {
    ...draft,
    proof: {
      circuitId: "batch-match", circuitHash: hashFields("test", [1]),
      verifierHash: hashFields("test", [2]), publicInputHash: hashFields("test", [3]),
      proofDigest: hashFields("test", [4]),
    },
  } as BatchSettlement;
  store.settlements.set(`${settlement.marketId}:${settlement.batchId}`, settlement);
  for (const intent of input.intents) {
    store.privateMatchIntents.set(intent.intentCommitment, intent as PrivateMatchIntent);
  }
  for (const fill of input.match.fills) {
    store.positionLifecycle.set(fill.positionCommitment, {
      batchId: input.batchId, marketId: input.market.marketId,
      openedAt: 1, ownerCommitment: fill.ownerCommitment,
      positionCommitment: fill.positionCommitment,
      positionNullifier: fill.positionNullifier,
      settlementDigest: draft.settlementDigest,
      sourceIntentCommitment: fill.intentCommitment,
      status: "open", updatedAt: 1,
    });
  }

  const recipient = createECDH("prime256v1");
  recipient.generateKeys();
  for (const fill of input.match.fills) {
    const recovered = recoverPositionOpeningEventsForOwner(
      store, fill.ownerCommitment, recipient.getPublicKey().toString("base64url"));
    expect(recovered.skipped).toEqual([]);
    expect(recovered.events).toHaveLength(1);
    const opening = decryptOpening(recovered.events[0].ciphertext, recipient);
    expect(opening.margin).toBe(fill.margin.toString());
    expect(opening.entryFee).toBe(
      fill.side === "long" ? "-150000" : "500000");
  }
});

function decryptOpening(ciphertext: string, recipient: ReturnType<typeof createECDH>): {
  entryFee: string;
  margin: string;
} {
  const envelope = JSON.parse(Buffer.from(ciphertext.split(":")[1], "base64url").toString("utf8")) as {
    ciphertext: string; ephemeralPublicKey: string; iv: string; tag: string;
  };
  const shared = recipient.computeSecret(Buffer.from(envelope.ephemeralPublicKey, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(shared).digest(),
    Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final(),
  ]);
  return (JSON.parse(plaintext.toString("utf8")) as { opening: { entryFee: string; margin: string } }).opening;
}
