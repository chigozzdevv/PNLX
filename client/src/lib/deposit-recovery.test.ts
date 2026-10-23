import { afterEach, beforeEach, expect, test } from "bun:test";
import { recoverPendingPrivateMarginDeposits, recoverWalletAssetDeposit } from "./deposit-recovery";
import { lockPrivateMarginNote, markPrivateMarginNoteSpent, privateMarginNotes, savePrivateMarginNote, setPrivateMarginNoteRuntimeScope } from "./private-margin-notes";
import type { Hex } from "@/types/trading";
import type { WalletSession } from "./wallet-auth";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const cm: Hex = `0x${"ab".repeat(32)}`, tx: Hex = `0x${"cd".repeat(32)}`, root: Hex = `0x${"ef".repeat(32)}`;
const session: WalletSession = { address: "GTEST", ownerCommitment: "0x11", token: "authenticated", expiresAt: Date.now() + 60_000 };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
}
beforeEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage(), sessionStorage: storage(), dispatchEvent: () => true } });
  setPrivateMarginNoteRuntimeScope("test:deposit");
  savePrivateMarginNote({ amount: "1000000", assetDigest: "0x1", blinding: "0x2", commitment: cm,
    noteNullifier: "0x3", noteFormat: "secure", ownerCommitment: session.ownerCommitment,
    ownerDigest: "0x4", rhoDigest: "0x5", spendSecretDigest: "0x6", walletAddress: session.address, status: "pending" });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setPrivateMarginNoteRuntimeScope(undefined);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
function receipt() {
  return { note: { commitment: cm, marginRoot: root, membershipRoot: root,
    membershipProof: { leaf: cm, root, indices: [false], siblings: [root] },
    onchain: { relays: [] }, confirmedRecovery: { txHash: tx, ledger: 123 } } };
}
function serve(options: { spent?: boolean; activeIntentCommitment?: Hex; beforeStatus?: () => void; reject?: boolean } = {}) {
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); requests.push(url);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer authenticated");
    if (url.endsWith("/deposit-asset/recover-confirmed")) {
      expect(JSON.parse(String(init?.body))).toEqual({ commitment: cm });
      return options.reject ? Response.json({ error: "transaction remains unknown" }, { status: 500 }) : Response.json(receipt());
    }
    expect(url).toEndWith("/notes/recovery-status");
    options.beforeStatus?.();
    return Response.json({ notes: [{ commitment: cm, known: true, spent: options.spent ?? false, activeIntentCommitment: options.activeIntentCommitment }] });
  }, { preconnect: () => {} });
  return requests;
}

test("recovers an existing pending deposit after reload without signing or resubmitting it", async () => {
  const requests = serve();
  expect(await recoverPendingPrivateMarginDeposits(session)).toBe(1);
  expect(privateMarginNotes()[0].status).toBe("available");
  expect(requests).toHaveLength(2);
  expect(requests.every((url) => !/signed-xdr|prepare|\/finalize/.test(url))).toBe(true);
});
test("unknown transactions preserve the pending opening", async () => {
  const requests = serve({ reject: true });
  expect(await recoverPendingPrivateMarginDeposits(session)).toBe(0);
  expect(privateMarginNotes()[0].status).toBe("pending");
  expect(requests).toHaveLength(1);
});
for (const state of [{ spent: true }, { activeIntentCommitment: "0x77" as Hex }]) {
  test(`does not promote a funded note with ${state.spent ? "a spent nullifier" : "an active order"}`, async () => {
    serve(state);
    expect(await recoverPendingPrivateMarginDeposits(session)).toBe(0);
    expect(privateMarginNotes()[0].status).toBe("pending");
  });
}
for (const newer of ["locked", "spent", "scope"] as const) {
  test(`a delayed recovery preserves newer ${newer} state`, async () => {
    serve({ beforeStatus: () => {
      if (newer === "locked") {
        savePrivateMarginNote({ ...privateMarginNotes()[0], status: "available" });
        lockPrivateMarginNote(cm, "0x88");
      }
      else if (newer === "spent") markPrivateMarginNoteSpent(cm);
      else setPrivateMarginNoteRuntimeScope("test:other-runtime");
    } });
    expect(await recoverPendingPrivateMarginDeposits(session)).toBe(0);
    if (newer !== "scope") expect(privateMarginNotes()[0].status).toBe(newer);
    else { setPrivateMarginNoteRuntimeScope("test:deposit"); expect(privateMarginNotes()[0].status).toBe("pending"); }
  });
}
test("rejects a receipt for a different prepared transaction", async () => {
  serve();
  await expect(recoverWalletAssetDeposit({ commitment: cm, expectedTxHash: `0x${"00".repeat(32)}`, session })).rejects.toThrow("does not match");
  expect(privateMarginNotes()[0].status).toBe("pending");
});
test("rejects a different commitment returned by the recovery service", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ note: { ...receipt().note, commitment: "0x99" } }), { preconnect: () => {} });
  await expect(recoverWalletAssetDeposit({ commitment: cm, session })).rejects.toThrow("does not match");
  expect(privateMarginNotes()[0].status).toBe("pending");
});
