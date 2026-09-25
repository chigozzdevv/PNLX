/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { privateMarginNotes, privatePendingBalance, privateSpendableBalance, savePrivateMarginNote, setPrivateMarginNoteRuntimeScope } from "@/lib/private-margin-notes";
import { recoverResidualClaim } from "@/lib/residual-claim";
import type { ClientProofProvider } from "@/lib/client-proof-provider";
import type { WalletSession } from "@/lib/wallet-auth";
import type { Hex } from "@/types/trading";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const intentCommitment = `0x${"11".repeat(32)}` as Hex;
const assetDigest = `0x${"22".repeat(32)}` as Hex;
const session: WalletSession = {
  address: "GTESTWALLET",
  expiresAt: Date.now() + 60_000,
  ownerCommitment: `0x${"33".repeat(32)}`,
  token: "test-token",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  setPrivateMarginNoteRuntimeScope(undefined);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("persists a private residual note before claim and reuses it after a failed relay", async () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dispatchEvent: () => true, localStorage: storage, sessionStorage: new MemoryStorage() },
  });
  setPrivateMarginNoteRuntimeScope("test:residual-retry");

  let failClaim = true;
  let backedUpCommitment: Hex | undefined;
  let claimedCommitment: Hex | undefined;
  let proofCommitment: Hex | undefined;
  const provider = {
    depositNote: async (input: { amount: bigint; commitment: Hex; tokenDigest: Hex }) => {
      proofCommitment = input.commitment;
      return {
        artifact: { proof: proofMeta(), proofBase64: "AA==", publicInputsBase64: "AA==", vkBase64: "AA==" },
        record: { amount: input.amount.toString(), commitment: input.commitment, tokenDigest: input.tokenDigest, proof: proofMeta() },
      };
    },
  } as unknown as ClientProofProvider;
  globalThis.fetch = Object.assign(async (request: RequestInfo | URL, init?: RequestInit) => {
    const path = String(request);
    if (path.endsWith("/health")) return Response.json({ runtime: { clientStorageScope: "test:residual-retry" } });
    if (path.endsWith("/orders/residual-claim")) {
      return Response.json({ amount: claimedCommitment ? "0" : "5000000", claimedCommitment, tokenDigest: assetDigest });
    }
    if (path.endsWith("/proofs/artifacts")) return Response.json({ artifact: {} });
    if (path.endsWith("/orders/claim-residual")) {
      expect(backedUpCommitment).toBe(proofCommitment);
      if (failClaim) return Response.json({ error: "Relay unavailable" }, { status: 503 });
      const body = JSON.parse(String(init?.body)) as { depositProof: { commitment: Hex } };
      claimedCommitment = body.depositProof.commitment;
      return Response.json({ amount: "5000000", commitment: claimedCommitment });
    }
    throw new Error(`Unexpected request ${path}`);
  }, { preconnect: originalFetch.preconnect });

  const recover = () => recoverResidualClaim({
    backUpNote: async (note) => { backedUpCommitment = note.commitment; },
    intentCommitment, proofProvider: provider, session,
  });
  await expect(recover()).rejects.toThrow("Relay unavailable");
  const [pending] = privateMarginNotes(session.ownerCommitment);
  expect(pending.status).toBe("claiming");
  expect(pending.commitment).toBe(proofCommitment!);
  expect(privatePendingBalance(session.ownerCommitment)).toBe(5_000_000n);
  expect(privateSpendableBalance(session.ownerCommitment)).toBe(0n);

  failClaim = false;
  const recovered = await recover();
  expect(recovered?.commitment).toBe(pending.commitment);
  expect(recovered?.status).toBe("available");
  expect(privateSpendableBalance(session.ownerCommitment)).toBe(5_000_000n);

  // An ambiguous response after the on-chain claim must still reconcile the same note.
  const unused = savePrivateMarginNote({
    ...pending,
    commitment: `0x${"99".repeat(32)}`,
    noteNullifier: `0x${"aa".repeat(32)}`,
    status: "claiming",
  });
  const confirmed = await recover();
  expect(confirmed?.commitment).toBe(pending.commitment);
  expect(privateMarginNotes(session.ownerCommitment).find((note) => note.commitment === unused.commitment)?.status).toBe("spent");
  expect(privatePendingBalance(session.ownerCommitment)).toBe(0n);
});

function proofMeta() {
  return {
    circuitId: `0x${"44".repeat(32)}` as Hex,
    circuitHash: `0x${"55".repeat(32)}` as Hex,
    verifierHash: `0x${"66".repeat(32)}` as Hex,
    publicInputHash: `0x${"77".repeat(32)}` as Hex,
    proofDigest: `0x${"88".repeat(32)}` as Hex,
  };
}

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
