import { createDecipheriv, createECDH, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { digestToFieldHex, ownerCommitment, secureMarginCommitment, secureMarginNullifier } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import type { ServerEnv } from "@/config/env";
import { AccountKeysService } from "@/features/account-keys/account-keys.service";
import { encodeStellarPublicKey } from "@/features/auth/auth.service";
import { LegacyExitRecoveryService, type LegacyExitOutputArchive } from "@/features/notes/legacy-exit-recovery";
import { registerNoteBackupRoutes } from "@/features/notes/note-backups";
import { Router } from "@/shared/http/router";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import type { RelayerService } from "@/workers/relayer/relayer.service";

const helper = "CBDBUPESYVEB5YIBMFK5TJOW54RHMUYNL7C47TLM6DHTUCEKJGK57UBK";
const key = (value: string) => digestToFieldHex(`legacy-exit-recovery:${value}`);
const recipient = () => { const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); return ecdh; };
const publicKey = (ecdh: ReturnType<typeof recipient>) => ecdh.getPublicKey().toString("base64url");

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pnlx-legacy-exit-recovery-")), path = join(directory, "state.json");
  const address = encodeStellarPublicKey(Buffer.alloc(32, 29)), owner = ownerCommitment(address) as Hex;
  const store = new FileProtocolStore(path);
  const opening = { amount: 100n, assetDigest: key("asset"), blinding: key("blind"), ownerDigest: digestToFieldHex(`owner:${owner}`),
    rhoDigest: key("rho"), spendSecretDigest: key("spend") };
  const note = { ...opening, amount: "100", commitment: secureMarginCommitment(opening), noteNullifier: secureMarginNullifier(opening) };
  const archive: LegacyExitOutputArchive = { ownerCommitment: owner, createdAt: Date.now(), confirmed: true,
    legacyExit: { helperContractId: helper, transactionHash: key("transaction"), closeCommitment: key("close-0"), outputIndex: 0 },
    positionClose: { closeCommitment: key("close-0"), positionCommitment: key("position-0"), positionNullifier: key("nullifier-0"),
      marginOutputCommitment: note.commitment }, closeOutputNote: note };
  store.positionCommitments.add(archive.positionClose.positionCommitment);
  store.addPositionOpening({ batchId: "legacy", marketId: "xlm-usd-perp", ownerCommitment: owner,
    positionCommitment: archive.positionClose.positionCommitment, positionNullifier: archive.positionClose.positionNullifier,
    sourceIntentCommitment: key("source"), settlementDigest: key("settlement"), status: "open", openedAt: 1, updatedAt: 1 });
  Object.assign(store.positionLifecycle.get(archive.positionClose.positionCommitment)!, { status: "closed",
    closeCommitment: archive.legacyExit.closeCommitment, marginOutputCommitment: note.commitment });
  store.addMarginCommitment(note.commitment);
  let receipt: unknown = { ledger: 2345, position_commitments: [key("position-0"), key("position-1")].map(value => value.slice(2)),
    position_nullifiers: [key("nullifier-0"), key("nullifier-1")].map(value => value.slice(2)),
    close_commitments: [key("close-0"), key("close-1")].map(value => value.slice(2)),
    margin_output_commitments: [note.commitment, key("output-1")].map(value => value.slice(2)) };
  let eventHash = archive.legacyExit.transactionHash, transactionStatus = "SUCCESS", reads = 0, spent = false;
  const relayer = {
    async readAsync({ payload }: { payload: { contractId: string; functionName: string } }) {
      reads++;
      if (payload.functionName === "receipt_by_close") { expect(payload.contractId).toBe(helper);
        return { stdout: JSON.stringify(receipt), output: `${JSON.stringify(receipt)}\nINFO read completed` }; }
      if (payload.functionName === "has_commitment") return { stdout: "true", output: "true\nINFO read completed" };
      if (payload.functionName === "is_spent") return { stdout: String(spent), output: `${spent}\nINFO read completed` };
      throw new Error("unexpected read");
    },
    async findContractEventTransaction(id: string, ledger: number, close: Hex) {
      expect(id).toBe(helper); expect(ledger).toBe(2345); expect(close).toBe(archive.legacyExit.closeCommitment); return eventHash;
    },
    async readTransactionStatus(hash: Hex) { expect(hash).toBe(archive.legacyExit.transactionHash); return transactionStatus; },
  } as unknown as RelayerService;
  const env = { mongodbUri: "", stellarOnchainRelay: true } as ServerEnv;
  const service = new LegacyExitRecoveryService(env, relayer, helper, async () => [archive]);
  return { directory, path, store, archive, address, owner, relayer, env, service,
    setReceipt: (value: unknown) => { receipt = value; }, setEventHash: (value: Hex) => { eventHash = value; },
    setStatus: (value: string) => { transactionStatus = value; }, setSpent: (value: boolean) => { spent = value; },
    reads: () => reads };
}

test("legacy origin verification binds trusted helper, immutable output index and exact successful event transaction", async () => {
  const f = fixture();
  try {
    expect(await f.service.verifyOutput(f.archive.legacyExit, f.archive.closeOutputNote.commitment)).toEqual({ ...f.archive.legacyExit,
      confirmed: true, positionCommitment: f.archive.positionClose.positionCommitment, positionNullifier: f.archive.positionClose.positionNullifier });
    expect(await f.service.verifyCloseOutput(f.archive.legacyExit.transactionHash, f.archive.legacyExit.closeCommitment,
      f.archive.closeOutputNote.commitment)).toMatchObject({ outputIndex: 0, confirmed: true,
      positionCommitment: f.archive.positionClose.positionCommitment, positionNullifier: f.archive.positionClose.positionNullifier });
    await expect(f.service.verifyOutput({ ...f.archive.legacyExit, helperContractId: "C" + "A".repeat(55) }, f.archive.closeOutputNote.commitment)).rejects.toThrow("not trusted");
    expect(f.reads()).toBe(2);
    await expect(f.service.verifyOutput({ ...f.archive.legacyExit, outputIndex: 1 }, f.archive.closeOutputNote.commitment)).rejects.toThrow("immutable helper receipt");
    f.setEventHash(key("unrelated-transaction"));
    await expect(f.service.verifyOutput(f.archive.legacyExit, f.archive.closeOutputNote.commitment)).rejects.toThrow("not confirmed");
    f.setEventHash(f.archive.legacyExit.transactionHash);
    for (const value of ["FAILED", "NOT_FOUND", "PENDING"]) {
      f.setStatus(value);
      await expect(f.service.verifyOutput(f.archive.legacyExit, f.archive.closeOutputNote.commitment)).rejects.toThrow("not confirmed");
    }
    f.setReceipt(null);
    await expect(f.service.verifyOutput(f.archive.legacyExit, f.archive.closeOutputNote.commitment)).rejects.toThrow("unavailable");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("recovery status returns helper confirmation while keeping authoritative spent and active-order protection", async () => {
  const f = fixture();
  try {
    const intent = key("active-intent");
    f.store.intents.set(intent, { ownerCommitment: f.owner, intentCommitment: intent, noteNullifier: f.archive.closeOutputNote.noteNullifier } as never);
    f.store.orderLifecycle.set(intent, { status: "open" } as never);
    const router = new Router({ authenticate: () => ({ address: f.address }), protectMutations: true });
    registerNoteBackupRoutes(router, { store: f.store } as never, f.env, f.relayer, "CPOOL", f.service);
    const request = () => router.handle(new Request("http://localhost/notes/recovery-status", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ notes: [{ commitment: f.archive.closeOutputNote.commitment,
        nullifier: f.archive.closeOutputNote.noteNullifier, legacyExit: f.archive.legacyExit }] }) }));
    const first = await (await request()).json();
    expect(first.notes[0]).toMatchObject({ known: true, spent: false, activeIntentCommitment: intent,
      legacyExit: { confirmed: true, helperContractId: helper, transactionHash: f.archive.legacyExit.transactionHash } });
    f.setSpent(true);
    expect((await (await request()).json()).notes[0].spent).toBe(true);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("authenticated key rotation after restart re-encrypts the exact legacy opening without relabeling its owner", async () => {
  const f = fixture();
  try {
    const fresh = recipient(), restarted = new FileProtocolStore(f.path);
    const keys = new AccountKeysService({ store: restarted } as never, f.service);
    const result = await keys.recoverDurable({ algorithm: "ecdh-p256-aes-gcm", ownerCommitment: f.owner, publicKey: publicKey(fresh) }, f.address);
    expect(result.repairedEventCount).toBe(1); expect(result.skipped).toEqual([]);
    const event = [...new FileProtocolStore(f.path).accountEvents.values()][0]!;
    const envelope = JSON.parse(Buffer.from(event.ciphertext.split(":")[1]!, "base64url").toString());
    const secret = fresh.computeSecret(Buffer.from(envelope.ephemeralPublicKey, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString());
    expect(payload.kind).toBe("legacy-position-close"); expect(payload.legacyExit).toEqual(f.archive.legacyExit);
    expect(payload.closeOutputNote).toEqual(f.archive.closeOutputNote);
    expect(payload.closeOutputNote.ownerDigest).toBe(digestToFieldHex(`owner:${f.owner}`));
    expect(payload.closeOutputNote.ownerDigest).not.toBe(digestToFieldHex(`owner:${f.address}`));
    await expect(keys.recoverDurable({ algorithm: "ecdh-p256-aes-gcm", ownerCommitment: f.owner, publicKey: publicKey(recipient()) },
      encodeStellarPublicKey(Buffer.alloc(32, 30)))).rejects.toThrow("authenticated");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("pending, corrupted, substituted and unfunded legacy archives emit no recoverable note", async () => {
  const f = fixture();
  try {
    const pub = publicKey(recipient());
    for (const change of [
      (archive: LegacyExitOutputArchive) => { archive.confirmed = false as never; },
      (archive: LegacyExitOutputArchive) => { archive.closeOutputNote.spendSecretDigest = key("wrong-secret"); },
      (archive: LegacyExitOutputArchive) => { archive.closeOutputNote.ownerDigest = digestToFieldHex(`owner:${f.address}`); },
      (archive: LegacyExitOutputArchive) => { archive.legacyExit.outputIndex = 1; },
      (archive: LegacyExitOutputArchive) => { archive.positionClose.positionNullifier = key("wrong-source"); },
    ]) {
      const bad = JSON.parse(JSON.stringify(f.archive)) as LegacyExitOutputArchive; change(bad);
      const service = new LegacyExitRecoveryService(f.env, f.relayer, helper, async () => [bad]);
      expect((await service.recoverEvents(new FileProtocolStore(f.path), f.owner, pub)).events).toEqual([]);
    }
    const unfunded = new FileProtocolStore(f.path); unfunded.marginCommitments.clear();
    expect((await f.service.recoverEvents(unfunded, f.owner, pub)).events).toEqual([]);
    f.setStatus("NOT_FOUND");
    expect((await f.service.recoverEvents(new FileProtocolStore(f.path), f.owner, pub)).events).toEqual([]);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
