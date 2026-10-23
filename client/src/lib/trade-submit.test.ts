/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { submitCustodyIntentFragment } from "./trade-submit";
import { lockPrivateMarginNote, planPrivateMarginNoteAllocations, privateMarginNotes, privateSpendableBalance, reconcilePrivateMarginNotes, savePrivateMarginNote, setPrivateMarginNoteRuntimeScope } from "./private-margin-notes";
import { clearPrivateNoteBackupKey, decryptNoteBackup } from "./private-note-backup";
import type { ClientProofProvider, IntentValidityRecord } from "./client-proof-provider";
import type { Hex, MarketDisplay } from "@/types/trading";
import type { WalletSession } from "./wallet-auth";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const owner: Hex = "0x11";
const intentCommitment: Hex = "0x22";
const session: WalletSession = { address: "GTEST", expiresAt: Date.now() + 60_000, ownerCommitment: owner, token: "auth" };
let localStorage: ReturnType<typeof storage>;
beforeEach(() => {
  clearPrivateNoteBackupKey();
  localStorage = storage();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage, sessionStorage: storage(), dispatchEvent: () => true } });
  setPrivateMarginNoteRuntimeScope("test:submit");
});
afterEach(() => {
  clearPrivateNoteBackupKey();
  globalThis.fetch = originalFetch;
  setPrivateMarginNoteRuntimeScope(undefined);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
});

test("persists policy and reserves collateral before sending all authenticated validity fields", async () => {
  const input = fragmentInput();
  globalThis.fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/proofs/artifacts")) return Response.json({ artifact: {} });
    expect(String(url)).toContain("/intents");
    expect(privateMarginNotes(owner)[0].status).toBe("locked");
    const stored = JSON.parse(localStorage.getItem("pnlx.private.conditional-strategies")!)[0];
    const body = JSON.parse(String(init?.body));
    expect(body.conditionalPolicy).toEqual({ stopLossPrice: "90", stopLossSalt: stored.stopLossSalt,
      takeProfitPrice: "110", takeProfitSalt: stored.takeProfitSalt });
    for (const field of ["assetDigest", "ownerDigest", "positionSeed", "matchingPayloadCommitment"] as const) {
      expect(body.validity[field]).toBe(validity[field]);
    }
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer auth");
    return Response.json({ intentCommitment, ownerCommitment: owner, marketId: "xlm-usd-perp" });
  }, { preconnect: () => {} });
  expect((await submitCustodyIntentFragment(input)).intentCommitment).toBe(intentCommitment);
  expect(privateMarginNotes(owner)[0].lockedByIntentCommitment).toBe(intentCommitment);
});

test("lost or ambiguous responses retain reservation until authenticated lifecycle evidence resolves it", async () => {
  const input = fragmentInput();
  globalThis.fetch = Object.assign(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/proofs/artifacts")) return Response.json({ artifact: {} });
    if (String(url).includes("/portfolio?")) return Response.json({ portfolio: { ownerCommitment: owner, orders: [] } });
    throw new TypeError("response lost after chain accepted");
  }, { preconnect: () => {} });
  await expect(submitCustodyIntentFragment(input)).rejects.toThrow("temporarily unavailable");
  expect(privateMarginNotes(owner)[0].status).toBe("locked");
  expect(() => planPrivateMarginNoteAllocations({ amount: 1n, ownerCommitment: owner })).toThrow();
});

test("only an explicit definitive rejection releases pre-submission collateral", async () => {
  const input = fragmentInput();
  globalThis.fetch = Object.assign(async (url: RequestInfo | URL) => String(url).endsWith("/proofs/artifacts")
    ? Response.json({ artifact: {} })
    : Response.json({ error: "Rejected before chain submission", submissionRejected: true }, { status: 400 }),
  { preconnect: () => {} });
  await expect(submitCustodyIntentFragment(input)).rejects.toThrow("Rejected before chain");
  expect(privateMarginNotes(owner)[0].status).toBe("available");
});

for (const consumed of [false, true]) {
  test(`a delayed successful submission cannot overwrite its change ${consumed ? "spent by" : "reserved for"} a newer order`, async () => {
    const backupKey = await installRecoveryKey();
    const input = fragmentInput({ amount: 600n });
    const received = deferred<void>();
    const delayedResponse = deferred<Response>();
    let backup: { commitment: Hex; ciphertext: string } | undefined;
    let changeCommitment: Hex | undefined;
    globalThis.fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/proofs/artifacts")) return Response.json({ artifact: {} });
      if (String(url).endsWith("/notes/backup")) {
        backup = JSON.parse(String(init?.body)) as typeof backup;
        return Response.json({ ciphertext: backup!.ciphertext });
      }
      expect(String(url)).toContain("/intents");
      const body = JSON.parse(String(init?.body)) as { validity: { noteChangeCommitment: Hex } };
      changeCommitment = body.validity.noteChangeCommitment;
      const notes = privateMarginNotes(owner);
      expect(notes.find((note) => note.commitment === input.allocation.note.commitment)?.status).toBe("locked");
      expect(notes.find((note) => note.commitment === changeCommitment)?.status).toBe("pending");
      expect(backup?.commitment).toBe(changeCommitment);
      received.resolve();
      return delayedResponse.promise;
    }, { preconnect: () => {} });
    const submission = submitCustodyIntentFragment(input);
    await Promise.race([received.promise, submission.then(() => { throw new Error("submission did not wait for response"); })]);
    const backedUpChange = await decryptNoteBackup(backupKey, owner, "test:submit", backup!);
    expect(backedUpChange.amount).toBe("400");
    expect(backedUpChange.noteFormat).toBe("secure");
    expect(backedUpChange.status).toBe("pending");
    reconcilePrivateMarginNotes({ orders: [{ intentCommitment, status: "filled" }] });
    const nextIntent: Hex = "0x1234";
    lockPrivateMarginNote(changeCommitment!, nextIntent);
    if (consumed) reconcilePrivateMarginNotes({ orders: [{ intentCommitment: nextIntent, status: "filled" }] });
    const beforeResponse = privateMarginNotes(owner).find((note) => note.commitment === changeCommitment)!;
    expect(beforeResponse.status).toBe(consumed ? "spent" : "locked");
    expect(beforeResponse.lockedByIntentCommitment).toBe(nextIntent);
    delayedResponse.resolve(Response.json({ intentCommitment, ownerCommitment: owner, marketId: "xlm-usd-perp" }));
    expect((await submission).intentCommitment).toBe(intentCommitment);
    expect(privateMarginNotes(owner).find((note) => note.commitment === changeCommitment)).toEqual(beforeResponse);
    reconcilePrivateMarginNotes({ orders: [
      { intentCommitment, status: "filled" },
      { intentCommitment: nextIntent, noteNullifier: beforeResponse.noteNullifier, status: consumed ? "filled" : "open" },
    ] });
    expect(privateMarginNotes(owner).find((note) => note.commitment === changeCommitment)?.status).toBe(consumed ? "spent" : "locked");
    expect(privateSpendableBalance(owner)).toBe(0n);
    expect(() => planPrivateMarginNoteAllocations({ amount: 1n, ownerCommitment: owner })).toThrow();
  });
}

const validity: IntentValidityRecord = {
  assetDigest: "0x33", batchDigest: "0x44", currentBatch: "1", expiryBatch: "2", intentCommitment,
  marginRoot: "0x55", marketDigest: "0x66", matchingPayloadCommitment: "0x77", noteChangeCommitment: "0x0",
  noteCommitment: "0x88", noteNullifier: "0x99", ownerCommitmentField: "0xaa", ownerDigest: "0xbb", positionSeed: "0xcc",
  proof: { circuitId: "intent-validity", circuitKey: "0x01", circuitHash: "0x02", verifierHash: "0x03", publicInputHash: "0x04", proofDigest: "0x05" },
};

function fragmentInput(options: { amount?: bigint } = {}): Parameters<typeof submitCustodyIntentFragment>[0] {
  const note = savePrivateMarginNote({ amount: "1000", assetDigest: validity.assetDigest, blinding: "0x01", commitment: validity.noteCommitment,
    noteNullifier: validity.noteNullifier, noteFormat: "secure", ownerCommitment: owner, ownerDigest: validity.ownerDigest,
    rhoDigest: "0x02", spendSecretDigest: "0x03", walletAddress: session.address });
  const provider: Pick<ClientProofProvider, "intentValidity"> = { intentValidity: async (input) =>
    ({ artifact: {} as never, record: { ...validity, noteChangeCommitment: input.noteChangeCommitment } }) };
  return { allocation: { amount: options.amount ?? 1000n, note }, batchId: "batch", collateralAsset: "USDC", collateralToken: "token",
    collateralTokenDigest: validity.assetDigest, conditionalStrategy: { stopLossPrice: 90n, takeProfitPrice: 110n },
    entryPriceProtocol: 100n, leverage: 10, limitPrice: 1, limitPriceProtocol: 100n, margin: 1000, marginProtocol: 1000n,
    market: { marketId: "xlm-usd-perp" } as MarketDisplay, membership: { commitment: note.commitment, marginRoot: "0x55", membershipRoot: "0x55",
      membershipProof: { indices: [], leaf: note.commitment, root: "0x55", siblings: [] } },
    proofProvider: provider as ClientProofProvider, protocolSize: 10n, session, side: "long" };
}

async function installRecoveryKey(): Promise<CryptoKey> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const request = <T>(result: T) => {
    const pending = { result, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => pending.onsuccess?.());
    return pending;
  };
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
    open: () => request({ transaction: () => ({ objectStore: () => ({ get: () => request(key) }) }), close() {} }),
  } });
  return key;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
