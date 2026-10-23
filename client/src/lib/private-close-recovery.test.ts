/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSecureMarginNote } from "@/lib/private-note";
import { restorePrivateCloseOutputNote } from "@/lib/private-close-recovery";
import { lockPrivateMarginNote, markPrivateMarginNoteSpent, privateMarginNotes, savePrivateMarginNote, setPrivateMarginNoteRuntimeScope } from "@/lib/private-margin-notes";
import type { PrivateAccountEventPayload } from "@/lib/account-encryption";
import type { WalletSession } from "@/lib/wallet-auth";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
const session: WalletSession = { address: "GTEST", expiresAt: Date.now() + 60_000, ownerCommitment: "0xabc", token: "test" };
let status: { known: boolean; spent: boolean; activeIntentCommitment?: string };
let statusReads: number;
beforeEach(() => {
  const localStorage = storage();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage, sessionStorage: storage(), dispatchEvent: () => true } });
  setPrivateMarginNoteRuntimeScope("test:close-recovery");
  status = { known: true, spent: false };
  statusReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toContain("/notes/recovery-status");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test");
    const request = JSON.parse(String(init?.body)) as { notes: [{ commitment: string; nullifier: string }] };
    statusReads++;
    return Response.json({ notes: [{ commitment: request.notes[0].commitment, ...status }] });
  }) as typeof fetch;
});
afterEach(() => {
  setPrivateMarginNoteRuntimeScope(undefined);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  globalThis.fetch = originalFetch;
});

test("recovers an unattended close output and never resurrects it after later spending", async () => {
  const payload = await outputPayload();
  expect(await restorePrivateCloseOutputNote(session, payload, session.ownerCommitment)).toBe(true);
  const note = privateMarginNotes(session.ownerCommitment)[0];
  expect(note.status).toBe("available");
  expect(note.noteFormat).toBe("secure");
  expect(note.runtimeScope).toBe("test:close-recovery");
  markPrivateMarginNoteSpent(note.commitment);
  expect(await restorePrivateCloseOutputNote(session, payload, session.ownerCommitment)).toBe(false);
  expect(privateMarginNotes(session.ownerCommitment)[0].status).toBe("spent");
  expect(statusReads).toBe(1);
});

test("a new device never exposes an already spent archived refund as available", async () => {
  const payload = await outputPayload();
  status.spent = true;
  expect(await restorePrivateCloseOutputNote(session, payload, session.ownerCommitment)).toBe(false);
  expect(privateMarginNotes(session.ownerCommitment)[0].status).toBe("spent");
  expect(await restorePrivateCloseOutputNote(session, payload, session.ownerCommitment)).toBe(false);
  expect(statusReads).toBe(1);
});

test("a refund reserved by an active order is restored with that exact lock", async () => {
  const payload = await outputPayload();
  status.activeIntentCommitment = "0xabcd";
  expect(await restorePrivateCloseOutputNote(session, payload, session.ownerCommitment)).toBe(true);
  expect(privateMarginNotes(session.ownerCommitment)[0].status).toBe("locked");
  expect(privateMarginNotes(session.ownerCommitment)[0].lockedByIntentCommitment).toBe("0xabcd");
});

test("unknown, malformed and unavailable spend status cannot activate a refund", async () => {
  const payload = await outputPayload();
  status.known = false;
  expect(await restorePrivateCloseOutputNote(session, payload, session.ownerCommitment)).toBe(false);
  expect(privateMarginNotes(session.ownerCommitment)).toHaveLength(0);
  for (const body of [{ notes: [] }, { notes: [{ known: true, spent: false }] }, { notes: null }]) {
    globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
    await expect(restorePrivateCloseOutputNote(session, payload, session.ownerCommitment)).rejects.toThrow("status is unavailable");
    expect(privateMarginNotes(session.ownerCommitment)).toHaveLength(0);
  }
  globalThis.fetch = (async () => { throw new Error("RPC offline"); }) as unknown as typeof fetch;
  await expect(restorePrivateCloseOutputNote(session, payload, session.ownerCommitment)).rejects.toThrow("temporarily unavailable");
  expect(privateMarginNotes(session.ownerCommitment)).toHaveLength(0);
});

test("an in-flight status response cannot overwrite a newer local reservation", async () => {
  const payload = await outputPayload();
  if (payload.kind !== "position-close" || !payload.closeOutputNote) throw new Error("fixture");
  const note = payload.closeOutputNote;
  let resolveStatus: ((value: Response) => void) | undefined;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveStatus = resolve; })) as unknown as typeof fetch;
  const recovery = restorePrivateCloseOutputNote(session, payload, session.ownerCommitment);
  for (let attempt = 0; !resolveStatus && attempt < 20; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  savePrivateMarginNote({ ...note, ownerCommitment: session.ownerCommitment, walletAddress: session.address, noteFormat: "secure" });
  lockPrivateMarginNote(note.commitment, "0x9999");
  resolveStatus!(Response.json({ notes: [{ commitment: note.commitment, known: true, spent: false }] }));
  expect(await recovery).toBe(false);
  expect(privateMarginNotes(session.ownerCommitment)[0].lockedByIntentCommitment).toBe("0x9999");
});

test("rejects wrong owner, tampered opening and output commitment substitution", async () => {
  const payload = await outputPayload();
  await expect(restorePrivateCloseOutputNote(session, payload, "0xdef")).rejects.toThrow("owner mismatch");
  if (payload.kind !== "position-close" || !payload.closeOutputNote) throw new Error("fixture");
  await expect(restorePrivateCloseOutputNote(session, { ...payload, closeOutputNote: { ...payload.closeOutputNote, amount: "101" } }, session.ownerCommitment)).rejects.toThrow("settled commitment");
  await expect(restorePrivateCloseOutputNote(session, { ...payload, positionClose: { ...payload.positionClose!, marginOutputCommitment: "0x12" } }, session.ownerCommitment)).rejects.toThrow("settled commitment");
  expect(privateMarginNotes(session.ownerCommitment)).toHaveLength(0);
});

async function outputPayload(): Promise<PrivateAccountEventPayload> {
  const note = await createSecureMarginNote({ amount: 100n, assetDigest: "0x01", blinding: "blind", owner: session.address, rho: "rho", spendSecret: "private" });
  return { kind: "position-close", closeOutputNote: { ...note, amount: note.amount.toString() },
    positionClose: { marginOutputCommitment: note.commitment, positionCommitment: "0x02", positionNullifier: "0x03" } };
}

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
