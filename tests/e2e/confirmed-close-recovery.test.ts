import { createDecipheriv, createECDH, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { commitConditionalOrder, digestToFieldHex, ownerCommitment, secureMarginCommitment, secureMarginNullifier } from "@pnlx/crypto";
import type { ConditionalOrderWitness, Hex, PairedPositionCloseRecord, PositionCloseWitness, PrivateMatchIntent, ProofMeta } from "@pnlx/protocol-types";
import { AccountKeysService } from "@/features/account-keys/account-keys.service";
import { recoverConfirmedCloseOutputEventsForOwner } from "@/features/account-keys/account-key-recovery";
import { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";
import { createDelegatedConditionalPolicy } from "@/shared/protocol/delegated-policies";
import type { StoredMakerNoteRecord } from "@/shared/maker-note-store";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { ProtectionKeeperService } from "@/workers/protection-keeper/protection-keeper.service";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";

const key = (label: string) => digestToFieldHex(`confirmed-close-recovery:${label}`);
const proof = (circuitId: string): ProofMeta => ({ circuitId, circuitKey: key(`${circuitId}-key`),
  circuitHash: key(`${circuitId}-source`), verifierHash: key(`${circuitId}-vk`),
  publicInputHash: key(`${circuitId}-public`), proofDigest: key(`${circuitId}-proof`) });
const recipient = () => { const value = createECDH("prime256v1"); value.generateKeys(); return value; };
const publicKey = (value: ReturnType<typeof recipient>) => value.getPublicKey().toString("base64url");
const env = { conditionalOrdersOnchainRequired: false, settlementsOnchainRequired: true };

async function confirmedFixture(markPrice = 95_000_000n) {
  const root = mkdtempSync(join(tmpdir(), "pnlx-confirmed-close-"));
  const path = join(root, "store.json");
  const store = new FileProtocolStore(path);
  const executor = { store };
  const owners = ["GRECOVERYOWNER0", "GRECOVERYOWNER1"];
  const market = { marketId: "xlm-usd-perp", fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };
  const intents: PrivateMatchIntent[] = [1n, -1n].map((side, index) => ({ batchId: "recovery", marketId: market.marketId,
    intentCommitment: key(`intent-${index}`), noteNullifier: key(`note-${index}`), ownerCommitment: ownerCommitment(owners[index]!),
    ownerDigest: key(`owner-${index}`), positionSeed: key(`seed-${index}`), noteChangeCommitment: "0x0",
    limitPrice: market.oraclePrice, margin: 200_000_000n, signedSize: side * 1_000_000_000n }));
  store.markets.set(market.marketId, market);
  const match = new BatchMatcherService().match({ batchId: "recovery", market, intents });
  const settlement = { ...prepareRisc0SettlementDraft({ batchId: "recovery", market, intents, match }), proof: proof("batch-match") };
  store.settlements.set("recovery", settlement);
  for (const intent of intents) {
    store.privateMatchIntents.set(intent.intentCommitment, intent);
    store.intents.set(intent.intentCommitment, { ...intent, assetDigest: key("asset") } as never);
  }
  for (const fill of match.fills) {
    store.positionCommitments.add(fill.positionCommitment);
    store.positionLifecycle.set(fill.positionCommitment, { batchId: "recovery", marketId: market.marketId,
      ownerCommitment: fill.ownerCommitment, positionCommitment: fill.positionCommitment, positionNullifier: fill.positionNullifier,
      sourceIntentCommitment: fill.intentCommitment, settlementDigest: settlement.settlementDigest, status: "open", openedAt: 1, updatedAt: 1 });
  }
  const position = [...store.positionLifecycle.values()].find((item) => item.sourceIntentCommitment === intents[0]!.intentCommitment)!;
  store.addDelegatedConditionalPolicy(createDelegatedConditionalPolicy({ stopLossPrice: "98000000", stopLossSalt: "private-stop" }, {
    intentCommitment: position.sourceIntentCommitment, marketId: market.marketId, ownerCommitment: position.ownerCommitment })!);
  const oldKey = recipient();
  new AccountKeysService(executor as never).upsert({ algorithm: "ecdh-p256-aes-gcm", ownerCommitment: intents[0]!.ownerCommitment,
    publicKey: publicKey(oldKey) }, owners[0]);
  store.updateMarket({ ...market, oraclePrice: markPrice });
  const settled = new Set<Hex>();
  const indices = new Map<Hex, number>();
  let submissions = 0;
  const prover = {
    async proveConditionalCloseAsync(input: ConditionalOrderWitness) { return { closeCommitment: commitConditionalOrder(input),
      marketId: input.marketId, markPrice: input.markPrice, positionNullifier: input.positionNullifier, proof: proof("conditional-close") }; },
    async provePositionClosePairAsync(inputs: [PositionCloseWitness, PositionCloseWitness], maintenanceRate: bigint,
      liquidation = false): Promise<PairedPositionCloseRecord> {
      const pairedProof = proof("position-close-pair");
      return { marketId: inputs[0].marketId, assetDigest: inputs[0].marginOutputAssetDigest,
        currentFundingIndex: inputs[0].currentFundingIndex, markPrice: inputs[0].markPrice,
        maintenanceRate, liquidation, positionRoot: inputs[0].positionRoot, proof: pairedProof,
        positions: inputs.map((input) => ({ marketId: input.marketId, markPrice: input.markPrice,
          currentFundingIndex: input.currentFundingIndex, positionRoot: input.positionRoot,
          positionCommitment: input.positionCommitment, positionNullifier: input.positionNullifier,
          closeCommitment: input.closeCommitment, newPositionCommitment: input.newPositionCommitment,
          marginOutputCommitment: input.marginOutputCommitment, proof: pairedProof })) as PairedPositionCloseRecord["positions"] };
    },
  };
  const onchain = {
    enabled: true, marketPriceAsync: async () => store.markets.get(market.marketId)!.oraclePrice, marketFundingIndexAsync: async () => 0n,
    registerConditionalOrderAsync: async () => ({ relays: [] }), triggerConditionalCloseAsync: async () => ({ relays: [] }),
    isPositionCloseSettledAsync: async (close: Hex) => settled.has(close), positionCloseAppendIndexAsync: async (close: Hex) => indices.get(close)!,
    positionPairTransactionStatus: async () => "SUCCESS",
    async settleJournaledPositionPair(pair: PairedPositionCloseRecord, conditional: boolean,
      beforeSubmit: (prepared: { txHash: Hex; xdr: string }) => Promise<void>) {
      submissions += 1;
      const txHash = key("confirmed-transaction");
      await beforeSubmit({ txHash, xdr: "signed-test-pair" });
      const appendAt = store.positionCommitments.size;
      for (const [index, leg] of pair.positions.entries()) { indices.set(leg.closeCommitment, appendAt + index); settled.add(leg.closeCommitment); }
      return { relays: [{ kind: "position-close", functionName: conditional ? "settle_pair_conditional_proven" : "settle_pair_proven",
        submitted: true, txHash }] };
    },
  };
  const closes = new PositionClosesService(executor as never, prover as never, onchain as never, env);
  const conditional = new ConditionalOrdersService(executor as never, prover as never, env as never, onchain as never);
  const keeper = new ProtectionKeeperService(executor as never, closes, conditional, onchain as never);
  await keeper.runOnce();
  expect(keeper.status.failures).toBe(0);
  expect(submissions).toBe(1);
  expect(store.positionCloses.size).toBe(2);
  const run = [...store.pendingPairedCloses.values()][0]!;
  expect(run.retired).toBe(true);
  expect(run.retiredReconciled).toBe(true);
  return { root, path, store, run, owners, oldKey, owner: intents[0]!.ownerCommitment };
}

function decrypt(ciphertext: string, keyPair: ReturnType<typeof recipient>): { kind: string; closeOutputNote: StoredMakerNoteRecord } {
  const envelope = JSON.parse(Buffer.from(ciphertext.split(":")[1]!, "base64url").toString("utf8"));
  const secret = keyPair.computeSecret(Buffer.from(envelope.ephemeralPublicKey, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(envelope.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
}

describe("confirmed paired output recovery", () => {
  test("offline close retains the exact secure output across restart and authenticated key rotation", async () => {
    const f = await confirmedFixture();
    try {
      const expected = f.run.outputNotes.find((note) => note.ownerCommitment === f.owner)!;
      const restarted = new FileProtocolStore(f.path);
      expect([...restarted.pendingPairedCloses.values()][0]!.outputNotes).toEqual(f.run.outputNotes);
      const fresh = recipient();
      const service = new AccountKeysService({ store: restarted } as never);
      const result = await service.recoverDurable({ algorithm: "ecdh-p256-aes-gcm", ownerCommitment: f.owner,
        publicKey: publicKey(fresh) }, f.owners[0]);
      expect(result.repairedEventCount).toBe(1);
      expect(result.skipped).toEqual([]);
      const rotated = new FileProtocolStore(f.path);
      expect(rotated.accountEncryptionKey(f.owner)?.publicKey).toBe(publicKey(fresh));
      const payloads = [...rotated.accountEvents.values()].filter((event) => event.ownerCommitment === f.owner)
        .flatMap((event) => { try { return [decrypt(event.ciphertext, fresh)]; } catch { return []; } });
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.kind).toBe("position-close");
      expect(payloads[0]!.closeOutputNote).toEqual(expected);
      const note = payloads[0]!.closeOutputNote;
      const opening = { amount: BigInt(note.amount!), assetDigest: note.assetDigest as Hex, ownerDigest: note.ownerDigest as Hex,
        blinding: note.blinding as Hex, rhoDigest: note.rhoDigest as Hex, spendSecretDigest: note.spendSecretDigest as Hex };
      expect(secureMarginCommitment(opening)).toBe(expected.commitment as Hex);
      expect(secureMarginNullifier(opening)).toBe(expected.noteNullifier as Hex);
      const recovered = recoverConfirmedCloseOutputEventsForOwner(rotated, f.owner, publicKey(fresh)).events[0]!;
      expect(() => decrypt(recovered.ciphertext, f.oldKey)).toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("pending, unfunded, losing, mismatched-transaction and corrupted openings are never emitted", async () => {
    const f = await confirmedFixture();
    try {
      const recipientKey = publicKey(recipient());
      const changes = [
        (store: FileProtocolStore) => { [...store.pendingPairedCloses.values()][0]!.retired = false; },
        (store: FileProtocolStore) => { [...store.pendingPairedCloses.values()][0]!.retiredReconciled = false; },
        (store: FileProtocolStore) => { const run = [...store.pendingPairedCloses.values()][0]!; run.settlementTxHash = key("wrong-tx"); },
        (store: FileProtocolStore) => { const close = store.positionsFor(f.owner)[0]!.closeCommitment!; store.positionCloses.delete(close); },
        (store: FileProtocolStore) => { store.positionsFor(f.owner)[0]!.closeCommitment = key("losing-close"); },
        (store: FileProtocolStore) => { const run = [...store.pendingPairedCloses.values()][0]!;
          run.outputNotes.find((note) => note.ownerCommitment === f.owner)!.blinding = key("corrupt-opening"); },
      ];
      for (const change of changes) {
        const store = new FileProtocolStore(f.path); change(store);
        expect(recoverConfirmedCloseOutputEventsForOwner(store, f.owner, recipientKey).events).toEqual([]);
      }
      const store = new FileProtocolStore(f.path);
      expect(recoverConfirmedCloseOutputEventsForOwner(store, key("other-owner"), recipientKey).events).toEqual([]);
      await expect(new AccountKeysService({ store } as never).recoverDurable({ algorithm: "ecdh-p256-aes-gcm",
        ownerCommitment: f.owner, publicKey: recipientKey }, f.owners[1])).rejects.toThrow("authenticated");
      expect(store.accountEncryptionKey(f.owner)?.publicKey).toBe(publicKey(f.oldKey));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test("a confirmed zero-equity output creates no spendable refund event", async () => {
    const f = await confirmedFixture(200_000_000n);
    try {
      const zero = f.run.outputNotes.find((note) => note.amount === "0")!;
      expect(zero).toBeDefined();
      expect(recoverConfirmedCloseOutputEventsForOwner(new FileProtocolStore(f.path), zero.ownerCommitment as Hex,
        publicKey(recipient())).events).toEqual([]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
