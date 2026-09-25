/// <reference types="bun" />

import { expect, test } from "bun:test";
import { createCircuitMarginNote } from "@/lib/private-note";
import { decryptNoteBackup, decryptOpeningBackup, encryptNoteBackup, encryptOpeningBackup, restorePrivateMarginNotes, restorePrivateOpenings } from "@/lib/private-note-backup";
import { setPrivateMarginNoteRuntimeScope } from "@/lib/private-margin-notes";
import type { StoredPrivateMarginNote } from "@/lib/private-margin-notes";
import type { Hex } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

test("an account with no encrypted notes does not request a recovery signature", async () => {
  const previousFetch = globalThis.fetch;
  const session = {
    address: "GTEST", expiresAt: Date.now() + 60_000,
    ownerCommitment: `0x${"11".repeat(32)}` as Hex, token: "test",
  } satisfies WalletSession;
  setPrivateMarginNoteRuntimeScope("test:empty-backup");
  globalThis.fetch = Object.assign(async () => Response.json({ backups: [] }), {
    preconnect: () => {},
  });
  try {
    expect(await restorePrivateMarginNotes(session)).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    setPrivateMarginNoteRuntimeScope(undefined);
  }
});

test("opening recovery reads every backup page without signing when none match", async () => {
  const previousFetch = globalThis.fetch;
  const first = `0x${"22".repeat(32)}` as Hex;
  const wanted = `0x${"33".repeat(32)}` as Hex;
  const session = {
    address: "GTEST", expiresAt: Date.now() + 60_000,
    ownerCommitment: `0x${"11".repeat(32)}` as Hex, token: "test",
  } satisfies WalletSession;
  setPrivateMarginNoteRuntimeScope("test:paginated-openings");
  const requests: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json(requests.length === 1
      ? { backups: [{ commitment: first, ciphertext: "unused" }], nextCursor: first }
      : { backups: [] });
  }, { preconnect: () => {} });
  try {
    expect(await restorePrivateOpenings(session, [wanted])).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain(`cursor=${encodeURIComponent(first)}`);
  } finally {
    globalThis.fetch = previousFetch;
    setPrivateMarginNoteRuntimeScope(undefined);
  }
});

test("encrypted note backup restores on another device and rejects tampering", async () => {
  const owner = `0x${"11".repeat(32)}` as Hex;
  const scope = "pnlx:testnet:/home/ubuntu/PNLX/deployments/testnet.json";
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const firstKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
  const secondKey = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const circuit = await createCircuitMarginNote({
    amount: 50_000_000n,
    assetId: "usdc",
    blinding: "first-blind",
    owner: "GTEST",
    rho: "first-rho",
    spendSecret: "first-spend",
  });
  const note: StoredPrivateMarginNote = {
    ...circuit,
    amount: circuit.amount.toString(),
    createdAt: Date.now(),
    ownerCommitment: owner,
    runtimeScope: scope,
    status: "available",
    updatedAt: Date.now(),
    walletAddress: "GTEST",
  };
  const ciphertext = await encryptNoteBackup(firstKey, owner, scope, note);
  expect(ciphertext).not.toContain(note.amount);
  expect(await decryptNoteBackup(secondKey, owner, scope, { commitment: note.commitment, ciphertext }))
    .toEqual(note);
  await expect(decryptNoteBackup(secondKey, owner, "pnlx:other", { commitment: note.commitment, ciphertext }))
    .rejects.toThrow();
  await expect(decryptNoteBackup(secondKey, owner, scope, {
    commitment: `0x${"22".repeat(32)}` as Hex,
    ciphertext,
  })).rejects.toThrow();
});

test("encrypted opening survives a browser key change", async () => {
  const owner = `0x${"33".repeat(32)}` as Hex;
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const oldBrowserKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const newBrowserKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const commitment = `0x${"44".repeat(32)}` as Hex;
  const payload = {
    kind: "position-opening" as const,
    opening: {
      entryPrice: "20000000", fundingIndex: "0", margin: "10000000",
      marketId: "xlm-usd-perp", positionCommitment: commitment,
      positionNullifier: `0x${"55".repeat(32)}` as Hex,
      side: "long" as const, size: "50000000",
      sourceIntentCommitment: `0x${"66".repeat(32)}` as Hex,
    },
  };
  const ciphertext = await encryptOpeningBackup(oldBrowserKey, owner, "testnet", payload);
  expect(await decryptOpeningBackup(newBrowserKey, owner, "testnet", { commitment, ciphertext }))
    .toEqual(payload);
  await expect(decryptOpeningBackup(newBrowserKey, owner, "mainnet", { commitment, ciphertext }))
    .rejects.toThrow();
});
