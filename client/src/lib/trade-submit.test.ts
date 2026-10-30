/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { custodyIntentCommitment, recoverAbandonedPrivateMarginPreparations, submitCustodyIntentFragment, submitCustodySharedTradeIntent } from "./trade-submit";
import { lockPrivateMarginNote, markPrivateMarginSubmissionAttempted, planPrivateMarginNoteAllocations, privateMarginNotes, privatePendingBalance, privateSpendableBalance, reconcilePrivateMarginNotes, reservePrivateMarginNotes, savePrivateMarginNote, setPrivateMarginNoteRuntimeScope } from "./private-margin-notes";
import { clearPrivateNoteBackupKey, decryptNoteBackup, syncPrivateMarginNoteBackup } from "./private-note-backup";
import type { ClientProofProvider, IntentValidityRecord } from "./client-proof-provider";
import type { Hex, MarketDisplay } from "@/types/trading";
import type { WalletSession } from "./wallet-auth";
import { commitIntent, ownerCommitment as serverOwnerCommitment } from "@pnlx/crypto";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const owner: Hex = "0x11";
let intentCommitment: Hex = "0x22";
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
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

test("persists policy and reserves collateral before sending all authenticated validity fields", async () => {
  const input = fragmentInput();
  globalThis.fetch = mockFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/proofs/artifacts")) return Response.json({ artifact: {} });
    expect(String(url)).toContain("/intents");
    expect(privateMarginNotes(owner)[0].status).toBe("locked");
    expect(privateMarginNotes(owner)[0].preparationOnly).toBe(false);
    const stored = JSON.parse(localStorage.getItem("pnlx.private.conditional-strategies")!)[0];
    const body = JSON.parse(String(init?.body));
    expect(body.conditionalPolicy).toEqual({ stopLossPrice: "90", stopLossSalt: stored.stopLossSalt,
      takeProfitPrice: "110", takeProfitSalt: stored.takeProfitSalt });
    for (const field of ["assetDigest", "ownerDigest", "positionSeed", "matchingPayloadCommitment"] as const) {
      expect(body.validity[field]).toBe(validity[field]);
    }
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer auth");
    return Response.json({ intentCommitment, ownerCommitment: owner, marketId: "xlm-usd-perp" });
  });
  expect((await submitCustodyIntentFragment(input)).intentCommitment).toBe(intentCommitment);
  expect(privateMarginNotes(owner)[0].lockedByIntentCommitment).toBe(intentCommitment);
});

test("lost or ambiguous responses retain reservation until authenticated lifecycle evidence resolves it", async () => {
  const input = fragmentInput();
  globalThis.fetch = mockFetch(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/proofs/artifacts")) return Response.json({ artifact: {} });
    if (String(url).includes("/portfolio?")) return Response.json({ portfolio: { ownerCommitment: owner, orders: [] } });
    throw new TypeError("response lost after chain accepted");
  });
  await expect(submitCustodyIntentFragment(input)).rejects.toThrow("temporarily unavailable");
  expect(privateMarginNotes(owner)[0].status).toBe("locked");
  expect(() => planPrivateMarginNoteAllocations({ amount: 1n, ownerCommitment: owner })).toThrow();
});

test("only an explicit definitive rejection releases pre-submission collateral", async () => {
  const input = fragmentInput();
  globalThis.fetch = mockFetch(async (url: RequestInfo | URL) => String(url).endsWith("/proofs/artifacts")
    ? Response.json({ artifact: {} })
    : Response.json({ error: "Rejected before chain submission", submissionRejected: true }, { status: 400 }),
  );
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
    globalThis.fetch = mockFetch(async (url: RequestInfo | URL, init?: RequestInit) => {
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
    });
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
  const provider: Pick<ClientProofProvider, "intentValidity"> = { intentValidity: async (input) => {
    intentCommitment = await custodyIntentCommitment({ ...input, owner: session.address }, owner);
    return { artifact: {} as never, record: { ...validity, intentCommitment, noteChangeCommitment: input.noteChangeCommitment } };
  } };
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

function mockFetch(handler: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>, options: {
  root?: () => Hex; spent?: () => boolean; activeIntent?: () => Hex | undefined; missingMembership?: () => boolean;
} = {}): typeof fetch {
  return Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    const address = new URL(String(url), "http://test.local");
    if (address.pathname.endsWith("/notes/membership")) {
      if (options.missingMembership?.()) return Response.json({ error: "margin note not found" }, { status: 404 });
      const commitment = address.searchParams.get("commitment") as Hex;
      const root = options.root?.() ?? "0x55";
      return Response.json({ note: { commitment, marginRoot: root, membershipRoot: root,
        membershipProof: { indices: [], siblings: [], leaf: commitment, root } } });
    }
    if (address.pathname.endsWith("/notes/recovery-status")) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ notes: body.notes.map((item: { commitment: Hex }) => ({ commitment: item.commitment,
        known: true, spent: options.spent?.() ?? false, activeIntentCommitment: options.activeIntent?.() })) });
    }
    return handler(url, init);
  }, { preconnect: () => {} });
}

test("browser preparation commitments match protocol commitments for both sides", async () => {
  for (const side of ["long", "short"] as const) {
    const intent = { batchId: "ui-1730000000000-xlm-usd-perp-2", marketId: "xlm-usd-perp", owner: "GTEST",
      side, size: 12_345_678_901n, limitPrice: 25_123_456n, margin: 1_234_567_890n,
      noteNullifier: "0x1234" as Hex, nonce: "distinct-nonce", salt: "distinct-salt" };
    expect(await custodyIntentCommitment(intent, serverOwnerCommitment(intent.owner))).toBe(commitIntent(intent));
  }
});

type ProofInput = Parameters<ClientProofProvider["intentValidity"]>[0];
async function proofFor(input: ProofInput) {
  return { artifact: {} as never, record: { ...validity,
    intentCommitment: await custodyIntentCommitment({ ...input }, owner), assetDigest: input.assetDigest,
    noteCommitment: input.noteCommitment, noteNullifier: input.noteNullifier, ownerDigest: input.ownerDigest,
    marginRoot: input.marginRoot, noteChangeCommitment: input.noteChangeCommitment } };
}
type ProofJob = { input: ProofInput; done: ReturnType<typeof deferred<Awaited<ReturnType<typeof proofFor>>>> };

function groupInput(count = 2, marginProtocol = BigInt(count) * 1_000_000n): Parameters<typeof submitCustodySharedTradeIntent>[0] {
  for (let index = 0; index < count; index++) savePrivateMarginNote({ amount: "1000000", assetDigest: validity.assetDigest,
    blinding: "0x01", commitment: ("0x" + (100 + index).toString(16)) as Hex,
    noteNullifier: ("0x" + (200 + index).toString(16)) as Hex, noteFormat: "secure", ownerCommitment: owner,
    ownerDigest: validity.ownerDigest, rhoDigest: "0x02", spendSecretDigest: "0x03", walletAddress: session.address });
  return { collateralAsset: "USDC", collateralToken: "token", collateralTokenDigest: validity.assetDigest,
    conditionalStrategy: null, entryPriceProtocol: 100_000_000n, leverage: 2, limitPrice: 1,
    limitPriceProtocol: 100_000_000n, margin: Number(marginProtocol) / 10_000_000, marginProtocol,
    market: { marketId: "xlm-usd-perp" } as MarketDisplay, protocolSize: marginProtocol, session, side: "long",
    proofProvider: testProofProvider(proofFor) };
}
function successfulService(log: string[] = []) {
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url), body = JSON.parse(String(init?.body ?? "{}"));
    if (path.endsWith("/notes/backup")) return Response.json({ ciphertext: body.ciphertext });
    if (path.endsWith("/proofs/artifacts")) { log.push("register"); return Response.json({ artifact: {} }); }
    if (path.endsWith("/intents")) { log.push("submit:" + body.intent.batchId.split("-").at(-1));
      return Response.json({ intentCommitment: body.validity.intentCommitment, ownerCommitment: owner, marketId: "xlm-usd-perp" }); }
    if (path.endsWith("/orders/cancel")) { log.push("cancel"); return Response.json({ order: { intentCommitment: body.intentCommitment, status: "cancelled" } }); }
    if (path.includes("/portfolio?")) return Response.json({ portfolio: { ownerCommitment: owner, orders: [] } });
    throw new Error("Unexpected request");
  };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Expected preparation progress did not arrive");
    await new Promise((done) => setTimeout(done, 1)); }
}

test("two notes prove together, finish before registration, and submit in deterministic serial order", async () => {
  const input = groupInput(), jobs: ProofJob[] = [], log: string[] = [];
  input.proofProvider = testProofProvider((request: ProofInput) => {
    const done = deferred<Awaited<ReturnType<typeof proofFor>>>(); jobs.push({ input: request, done }); return done.promise;
  });
  const firstSubmitted = deferred<void>(), firstResponse = deferred<void>(), base = successfulService(log);
  globalThis.fetch = mockFetch(async (url, init) => {
    if (String(url).endsWith("/intents") && !log.some((value) => value.startsWith("submit:"))) {
      const response = await base(url, init); firstSubmitted.resolve(); await firstResponse.promise; return response;
    }
    return base(url, init);
  });
  const operation = submitCustodySharedTradeIntent(input);
  await waitFor(() => jobs.length === 2);
  expect(privateMarginNotes(owner).every((note) => note.status === "locked" && note.submissionPending)).toBe(true);
  await expect(submitCustodySharedTradeIntent(input)).rejects.toThrow("already being prepared");
  jobs[1].done.resolve(await proofFor(jobs[1].input));
  await new Promise((done) => setTimeout(done, 5)); expect(log).toEqual([]);
  jobs[0].done.resolve(await proofFor(jobs[0].input)); await firstSubmitted.promise;
  expect(log).toEqual(["register", "submit:1"]);
  firstResponse.resolve(); expect((await operation).intents).toHaveLength(2);
  expect(log).toEqual(["register", "submit:1", "register", "submit:2"]);
});

test("failed preparation waits for late proof work before releasing all unsubmitted inputs and change", async () => {
  await installRecoveryKey();
  const input = groupInput(2, 1_500_000n), jobs: ProofJob[] = [], log: string[] = [];
  input.proofProvider = testProofProvider((request: ProofInput) => {
    const done = deferred<Awaited<ReturnType<typeof proofFor>>>(); jobs.push({ input: request, done }); return done.promise;
  });
  globalThis.fetch = mockFetch(successfulService(log));
  const outcome = submitCustodySharedTradeIntent(input).then(() => "unexpected", (error: Error) => error.message);
  await waitFor(() => jobs.length === 2); jobs[1].done.reject(new Error("Proof preparation failed"));
  await new Promise((done) => setTimeout(done, 5));
  expect(privateSpendableBalance(owner)).toBe(0n); expect(log).toEqual([]);
  jobs[0].done.resolve(await proofFor(jobs[0].input));
  expect(await outcome).toBe("Proof preparation failed"); expect(privateSpendableBalance(owner)).toBe(2_000_000n);
  expect(privateMarginNotes(owner).filter((note) => note.status === "pending")).toHaveLength(0); expect(log).toEqual([]);
});

test("three inputs never exceed two parallel proof jobs", async () => {
  const input = groupInput(3), jobs: ProofJob[] = [];
  let active = 0, peak = 0;
  input.proofProvider = testProofProvider(async (request: ProofInput) => {
    active++; peak = Math.max(peak, active);
    const done = deferred<Awaited<ReturnType<typeof proofFor>>>(); jobs.push({ input: request, done });
    try { return await done.promise; } finally { active--; }
  });
  globalThis.fetch = mockFetch(successfulService());
  const operation = submitCustodySharedTradeIntent(input); await waitFor(() => jobs.length === 2);
  jobs[1].done.resolve(await proofFor(jobs[1].input)); await waitFor(() => jobs.length === 3); expect(peak).toBe(2);
  jobs[2].done.resolve(await proofFor(jobs[2].input)); jobs[0].done.resolve(await proofFor(jobs[0].input));
  expect((await operation).intents).toHaveLength(3);
});

test("stale roots prevent submission and release unsubmitted reservations", async () => {
  const input = groupInput(), log: string[] = [], base = successfulService(log);
  let root: Hex = "0x55";
  globalThis.fetch = mockFetch(async (url, init) => { const response = await base(url, init);
    if (String(url).endsWith("/proofs/artifacts")) root = "0x66"; return response;
  }, { root: () => root });
  await expect(submitCustodySharedTradeIntent(input)).rejects.toThrow("collateral changed");
  expect(log).toEqual(["register"]); expect(privateSpendableBalance(owner)).toBe(2_000_000n);
});

for (const ambiguous of [false, true]) test("later " + (ambiguous ? "ambiguous" : "rejected") + " submission preserves cancellation and reservation evidence", async () => {
  const input = groupInput(3), log: string[] = [], base = successfulService(log);
  let submissions = 0;
  globalThis.fetch = mockFetch(async (url, init) => {
    if (String(url).endsWith("/intents") && ++submissions === 2) {
      if (ambiguous) throw new TypeError("Response lost after possible acceptance");
      return Response.json({ error: "Definitive rejection", submissionRejected: true }, { status: 400 });
    }
    return base(url, init);
  });
  await expect(submitCustodySharedTradeIntent(input)).rejects.toThrow(ambiguous ? "temporarily unavailable" : "Definitive rejection");
  expect(submissions).toBe(2); expect(log).toEqual(["register", "submit:1", "register", "cancel"]);
  expect(privateSpendableBalance(owner)).toBe(ambiguous ? 2_000_000n : 3_000_000n);
  expect(privateMarginNotes(owner).filter((note) => note.status === "locked")).toHaveLength(ambiguous ? 1 : 0);
});

function testProofProvider(intentValidity: ClientProofProvider["intentValidity"]): ClientProofProvider {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected proof kind"); };
  return { intentValidity, depositNote: unexpected, secureDepositNote: unexpected,
    positionClose: unexpected, withdraw: unexpected, secureWithdraw: unexpected };
}

test("another tab holding the owner WebLock prevents any preparation or submission", async () => {
  const input = groupInput();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    request: async (name: string, options: { ifAvailable: boolean }, callback: (lock: null) => unknown) => {
      expect(name).toContain("test:submit"); expect(options.ifAvailable).toBe(true); return callback(null);
    },
  } } });
  globalThis.fetch = mockFetch(async () => { throw new Error("No request should start"); });
  await expect(submitCustodySharedTradeIntent(input)).rejects.toThrow("already being prepared");
  expect(privateSpendableBalance(owner)).toBe(2_000_000n);
});

test("authoritatively spent input is never submitted or restored as available", async () => {
  const input = groupInput(), log: string[] = [];
  globalThis.fetch = mockFetch(successfulService(log), { spent: () => true });
  await expect(submitCustodySharedTradeIntent(input)).rejects.toThrow("no longer spendable");
  expect(log).toEqual(["register"]);
  expect(privateSpendableBalance(owner)).toBe(1_000_000n);
  expect(privateMarginNotes(owner).filter((note) => note.status === "spent")).toHaveLength(1);
});

function availablePreparationLock() {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}),
  } } });
}

async function abandonedPreparation() {
  const input = fragmentInput({ amount: 600n });
  const source = input.allocation.note;
  const intent = { batchId: input.batchId, marketId: input.market.marketId, limitPrice: input.limitPriceProtocol,
    margin: input.allocation.amount, size: input.protocolSize, side: input.side, owner: session.address,
    noteNullifier: source.noteNullifier, nonce: "abandoned-nonce", salt: "abandoned-salt" };
  const id = await custodyIntentCommitment(intent, owner);
  reservePrivateMarginNotes([{ commitment: source.commitment, intentCommitment: id }]);
  savePrivateMarginNote({ ...source, commitment: "0xcafe", noteNullifier: "0xcaff", amount: "400", status: "pending",
    lockedByIntentCommitment: id, submissionPending: undefined, preparationOnly: undefined });
  return { source, id };
}

test("reload recovers a durably unsubmitted abandoned preparation only under exclusive owner lock", async () => {
  const { source } = await abandonedPreparation();
  const persisted = localStorage.getItem("pnlx.private.margin-notes.v1")!;
  expect(JSON.parse(persisted).find((note: { commitment: Hex }) => note.commitment === source.commitment).preparationOnly).toBe(true);
  // A reloaded device sees only this persisted ledger, without the previous request's in-memory plan.
  localStorage.setItem("pnlx.private.margin-notes.v1", persisted);
  availablePreparationLock();
  globalThis.fetch = mockFetch(async () => { throw new Error("Only read-only recovery status is allowed"); });
  await recoverAbandonedPrivateMarginPreparations(session);
  expect(privateSpendableBalance(owner)).toBe(1000n);
  expect(privateMarginNotes(owner).find((note) => note.commitment === "0xcafe")?.status).toBe("spent");
  expect(privateMarginNotes(owner).find((note) => note.commitment === source.commitment)).toMatchObject({
    status: "available", preparationOnly: undefined, submissionPending: undefined,
  });
});

test("held other-tab lock never releases an active preparation", async () => {
  const { source } = await abandonedPreparation();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) => callback(null),
  } } });
  let calls = 0;
  globalThis.fetch = mockFetch(async () => { calls++; throw new Error("Must not query or mutate"); });
  await recoverAbandonedPrivateMarginPreparations(session);
  expect(calls).toBe(0); expect(privateSpendableBalance(owner)).toBe(0n);
  expect(privateMarginNotes(owner).find((note) => note.commitment === source.commitment)?.preparationOnly).toBe(true);
});

for (const stage of ["attempted", "unknown"] as const) test("reload never unlocks " + stage + " submission evidence", async () => {
  const { source, id } = await abandonedPreparation();
  if (stage === "attempted") markPrivateMarginSubmissionAttempted(source.commitment, id);
  else savePrivateMarginNote({ ...privateMarginNotes(owner).find((note) => note.commitment === source.commitment)!, preparationOnly: undefined });
  availablePreparationLock();
  globalThis.fetch = mockFetch(async () => { throw new Error("No recovery lookup expected"); });
  await recoverAbandonedPrivateMarginPreparations(session);
  expect(privateSpendableBalance(owner)).toBe(0n);
  expect(privateMarginNotes(owner).find((note) => note.commitment === source.commitment)?.status).toBe("locked");
  expect(privateMarginNotes(owner).find((note) => note.commitment === "0xcafe")?.status).toBe("pending");
});

test("a preparation with any authoritative active intent stays locked after reload", async () => {
  const { source, id } = await abandonedPreparation();
  availablePreparationLock();
  globalThis.fetch = Object.assign(async () => Response.json({ notes: [{ commitment: source.commitment,
    known: true, spent: false, activeIntentCommitment: id }] }), { preconnect: () => {} });
  await recoverAbandonedPrivateMarginPreparations(session);
  expect(privateSpendableBalance(owner)).toBe(0n);
  expect(privateMarginNotes(owner).find((note) => note.commitment === source.commitment)?.status).toBe("locked");
});

test("wallet reconnect invokes abandoned preparation recovery before restoring spendable notes", async () => {
  await installRecoveryKey();
  await abandonedPreparation();
  // This existing wallet completed note-backup migration before the interrupted order.
  localStorage.setItem("pnlx.private-note-backup.migrated:" + owner + ":test:submit", "1");
  availablePreparationLock();
  const base = successfulService();
  globalThis.fetch = mockFetch(async (url, init) => {
    if (String(url).endsWith("/health")) return Response.json({ runtime: { clientStorageScope: "test:submit" } });
    if (String(url).includes("/notes/backups?")) return Response.json({ backups: [] });
    return base(url, init);
  });
  await syncPrivateMarginNoteBackup(session);
  expect(privateSpendableBalance(owner)).toBe(1000n);
  expect(privateMarginNotes(owner).filter((note) => note.status === "pending")).toHaveLength(0);
});

for (const finalStatus of ["cancelled", "filled"] as const) test("foreign authoritative lock is retained until its exact " + finalStatus + " evidence", async () => {
  await installRecoveryKey();
  const input = fragmentInput({ amount: 600n }), source = input.allocation.note, foreign: Hex = "0x9999", log: string[] = [];
  globalThis.fetch = mockFetch(successfulService(log), { activeIntent: () => foreign });
  await expect(submitCustodyIntentFragment(input)).rejects.toThrow("reserved by another order");
  expect(log).toEqual(["register"]); expect(privateSpendableBalance(owner)).toBe(0n); expect(privatePendingBalance(owner)).toBe(0n);
  expect(privateMarginNotes(owner).find((note) => note.commitment === source.commitment)).toMatchObject({
    status: "locked", lockedByIntentCommitment: foreign, preparationOnly: false, submissionPending: false,
  });
  reconcilePrivateMarginNotes({ orders: [{ intentCommitment: "0xdead", noteNullifier: source.noteNullifier, status: "cancelled" }] });
  expect(privateSpendableBalance(owner)).toBe(0n);
  reconcilePrivateMarginNotes({ orders: [{ intentCommitment: foreign, status: finalStatus }] });
  expect(privateSpendableBalance(owner)).toBe(finalStatus === "cancelled" ? 1000n : 0n);
  expect(privatePendingBalance(owner)).toBe(0n);
});

test("missing membership after change creation retires both unavailable input and unused pending change", async () => {
  await installRecoveryKey();
  const input = fragmentInput({ amount: 600n }), log: string[] = [];
  globalThis.fetch = mockFetch(successfulService(log), { missingMembership: () => true });
  await expect(submitCustodyIntentFragment(input)).rejects.toThrow("margin note not found");
  expect(log).toEqual(["register"]); expect(privateSpendableBalance(owner)).toBe(0n); expect(privatePendingBalance(owner)).toBe(0n);
  expect(privateMarginNotes(owner).every((note) => note.status === "spent")).toBe(true);
});

test("membership response after a runtime switch cannot retire the other runtime's equal commitment", async () => {
  await installRecoveryKey();
  const input = fragmentInput({ amount: 600n }), source = input.allocation.note;
  globalThis.fetch = mockFetch(successfulService(), { missingMembership: () => {
    setPrivateMarginNoteRuntimeScope("test:different-runtime");
    savePrivateMarginNote({ ...source, amount: "9999", runtimeScope: "test:different-runtime" });
    return true;
  } });
  await expect(submitCustodyIntentFragment(input)).rejects.toThrow("margin note not found");
  expect(privateSpendableBalance(owner)).toBe(9999n);
  setPrivateMarginNoteRuntimeScope("test:submit");
  expect(privateSpendableBalance(owner)).toBe(1000n); expect(privatePendingBalance(owner)).toBe(0n);
});
