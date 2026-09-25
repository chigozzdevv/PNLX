import { expect, test } from "bun:test";
import { ownerCommitment } from "@pnlx/crypto";
import type { ServerEnv } from "@/config/env";
import { encodeStellarPublicKey } from "@/features/auth/auth.service";
import { registerNoteBackupRoutes } from "@/features/notes/note-backups";
import { Router } from "@/shared/http/router";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { RelayerService } from "@/workers/relayer/relayer.service";

test("note recovery status keeps an active order locked", async () => {
  const address = encodeStellarPublicKey(Buffer.alloc(32, 7));
  const owner = ownerCommitment(address);
  const commitment = `0x${"11".repeat(32)}` as const;
  const nullifier = `0x${"22".repeat(32)}` as const;
  const intentCommitment = `0x${"33".repeat(32)}` as const;
  const store = {
    marginCommitments: new Set([commitment]),
    spentNullifiers: new Set<string>(),
    intents: new Map([[intentCommitment, { intentCommitment, noteNullifier: nullifier, ownerCommitment: owner }]]),
    orderLifecycle: new Map([[intentCommitment, { status: "open" }]]),
  };
  const router = new Router({ authenticate: () => ({ address }), protectMutations: true });
  registerNoteBackupRoutes(router, { store } as unknown as ExecutorService, { mongodbUri: "" } as ServerEnv);
  const request = () => router.handle(new Request("http://localhost/notes/recovery-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes: [{ commitment, nullifier }] }),
  }));

  expect((await (await request()).json()).notes).toEqual([{
    commitment, known: true, spent: false, activeIntentCommitment: intentCommitment,
  }]);
  store.spentNullifiers.add(nullifier);
  expect((await (await request()).json()).notes[0].spent).toBe(true);
});

test("note recovery status checks the pool before restoring a balance", async () => {
  const address = encodeStellarPublicKey(Buffer.alloc(32, 8));
  const commitment = `0x${"44".repeat(32)}` as const;
  const nullifier = `0x${"55".repeat(32)}` as const;
  const store = {
    marginCommitments: new Set([commitment]),
    spentNullifiers: new Set<string>(),
    intents: new Map(),
    orderLifecycle: new Map(),
  };
  let onchainKnown = false;
  let onchainSpent = false;
  let poolReads = 0;
  const relayer = {
    readAsync: async ({ payload }: { payload: { functionName: string } }) => {
      poolReads += 1;
      return { output: String(payload.functionName === "has_commitment" ? onchainKnown : onchainSpent) };
    },
  } as unknown as RelayerService;
  const router = new Router({ authenticate: () => ({ address }), protectMutations: true });
  registerNoteBackupRoutes(
    router,
    { store } as unknown as ExecutorService,
    { mongodbUri: "", stellarOnchainRelay: true } as ServerEnv,
    relayer,
    "CPOOL",
  );
  const status = async () => {
    const response = await router.handle(new Request("http://localhost/notes/recovery-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: [{ commitment, nullifier }] }),
    }));
    return (await response.json()).notes[0];
  };

  expect(await status()).toMatchObject({ known: false, spent: false });
  expect(poolReads).toBe(1);
  onchainKnown = true;
  onchainSpent = true;
  expect(await status()).toMatchObject({ known: true, spent: true });
  expect(poolReads).toBe(3);
  store.marginCommitments.delete(commitment);
  expect(await status()).toMatchObject({ known: false, spent: false });
  expect(poolReads).toBe(3);
});
