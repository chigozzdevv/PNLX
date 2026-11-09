import { describe, expect, test } from "bun:test";
import {
  fieldHex,
  ownerCommitment,
  secureMarginCommitment,
  secureMarginRoot,
  hashFields,
} from "@pnlx/crypto";
import type { Hex, IntentRecord, PrivateMatchIntent } from "@pnlx/protocol-types";
import { ProtocolStore } from "@/shared/state/store";
import { ExecutorService } from "@/workers/executor/executor.service";
import { BatchExecutorService } from "@/workers/batch-executor/batch-executor.service";
import {
  buildMakerChangeNote,
  eligibleMakerNotes,
  MakerLiquidityService,
  makerPendingQuoteIsValid,
  makerQuoteForIntent,
  finalizedMakerNotes,
  selectMakerNoteAllocations,
} from "@/workers/maker-liquidity/maker-liquidity.service";

const note = {
  amount: "5000000000",
  assetDigest: hashFields("asset", ["usdc"]),
  blinding: hashFields("maker", ["blinding"]),
  commitment: hashFields("maker", ["note"]),
  noteNullifier: hashFields("maker", ["nullifier"]),
  ownerCommitment: hashFields("maker", ["owner"]),
  ownerDigest: hashFields("owner", ["maker"]),
  rhoDigest: hashFields("maker", ["rho"]),
  spendSecretDigest: hashFields("maker", ["spend"]),
  status: "available" as const,
  token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
};

const payload: PrivateMatchIntent = {
  batchId: "client-batch",
  intentCommitment: hashFields("intent", ["client"]),
  limitPrice: 19_775_000n,
  margin: 10_000_000n,
  marketId: "xlm-usd-perp",
  noteChangeCommitment: "0x0",
  noteNullifier: hashFields("client", ["nullifier"]),
  ownerCommitment: hashFields("client", ["owner"]),
  ownerDigest: hashFields("fixture-owner-digest", ["client"]),
  positionSeed: hashFields("fixture-position-seed", ["client"]),
  signedSize: 505_689_001n,
};

test("idle batch workers recover maker collateral without matching or overlapping recovery", async () => {
  const executor = new ExecutorService({}, new ProtocolStore());
  const maker = new MakerLiquidityService(executor, undefined as never, undefined,
    { intentRegistryOnchainRequired: false });
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let recoveries = 0;
  Reflect.set(maker, "recoverMakerNotes", async () => {
    recoveries++;
    started();
    await waiting;
    return { notes: [], blockedNotes: new Set() };
  });
  const batch = new BatchExecutorService(executor, {
    createSettlementTranscript() { throw new Error("idle recovery must not create a trade"); },
  }, { intervalMs: 5 }, undefined, maker);
  try {
    batch.start();
    await entered;
    await Bun.sleep(30);
    expect(recoveries).toBe(1);
    release();
    await Bun.sleep(10);
    expect(recoveries).toBe(1);
  } finally {
    release();
    batch.stop();
  }
});

test("maker admission and settlement wait for recovery and resume after a recovery failure", async () => {
  const maker = new MakerLiquidityService(new ExecutorService({}, new ProtocolStore()), undefined as never,
    undefined, { intentRegistryOnchainRequired: false });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  Reflect.set(maker, "recoverMakerNotes", async () => {
    events.push("recover");
    await waiting;
    throw new Error("temporary registry failure");
  });
  Reflect.set(maker, "ensureMarketLiquidity", async () => {
    events.push("admit");
    return { created: 0, skipped: 0 };
  });
  Reflect.set(maker, "finalizeMakerSettlement", async () => { events.push("settle"); });
  const recovering = maker.recover().catch((error) => error as Error);
  const admission = maker.ensureForMarket({ batchId: "waiting", marketId: "xlm-usd-perp" });
  const settlement = maker.finalizeSettlement({} as never);
  await Bun.sleep(5);
  expect(events).toEqual(["recover"]);
  release();
  expect(await recovering).toMatchObject({ message: "temporary registry failure" });
  await Promise.all([admission, settlement]);
  expect(events).toEqual(["recover", "admit", "settle"]);
});

test("maker wallet availability cannot append unconfirmed notes to the on-chain membership cache", () => {
  const store = new ProtocolStore(), confirmed = fieldHex(901n);
  store.addMarginCommitment(confirmed);
  const maker = new MakerLiquidityService(new ExecutorService({}, store), {} as never,
    { enabled: true } as never, { intentRegistryOnchainRequired: true });
  Reflect.get(maker, "indexMakerMarginCommitments").call(maker, [note]);
  expect([...store.marginCommitments]).toEqual([confirmed]);
});

test("maker selection refreshes confirmed membership and excludes wallet notes absent from the chain", async () => {
  const store = new ProtocolStore(), funded = { ...note, commitment: fieldHex(902n) };
  store.addMarginCommitment(note.commitment);
  store.addMarket({ marketId: payload.marketId, oraclePrice: payload.limitPrice, fundingIndex: 0n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n });
  const source = { intentCommitment: payload.intentCommitment, marketId: payload.marketId } as IntentRecord;
  store.intents.set(source.intentCommitment, source);
  store.privateMatchIntents.set(source.intentCommitment, payload);
  store.orderLifecycle.set(source.intentCommitment, { intentCommitment: source.intentCommitment,
    batchId: "source", marketId: source.marketId, ownerCommitment: payload.ownerCommitment,
    status: "open", createdAt: 1, updatedAt: 1 });
  let reads = 0;
  const maker = new MakerLiquidityService(new ExecutorService({}, store), {} as never,
    { enabled: true, secureNoteSnapshot: () => {
      reads++;
      return { commitments: [funded.commitment], root: secureMarginRoot([funded.commitment]) };
    } } as never, { intentRegistryOnchainRequired: true });
  Reflect.set(maker, "recoverMakerNotes", async () => ({ notes: [note, funded], blockedNotes: new Set() }));
  const selected: Hex[] = [];
  Reflect.set(maker, "submitMakerIntent", async (input: { note: { commitment: Hex } }) => {
    selected.push(input.note.commitment);
    return undefined;
  });
  await maker.ensureForMarket({ batchId: "confirmed-selection", marketId: source.marketId });
  expect(reads).toBe(1);
  expect(selected).toEqual([funded.commitment]);
  expect([...store.marginCommitments]).toEqual([funded.commitment]);
});

describe("maker note allocation", () => {
  test("uses only notes from the configured maker account", () => {
    const anotherWallet = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
    const otherNote = { ...note, walletAddress: anotherWallet };
    expect(eligibleMakerNotes([note, otherNote], note.walletAddress)).toEqual([note]);
    expect(eligibleMakerNotes([note, otherNote])).toHaveLength(2);
  });

  test("does not use the vault maker account outside XLM/USD", async () => {
    const service = new MakerLiquidityService(
      undefined as never,
      undefined as never,
      undefined,
      { intentRegistryOnchainRequired: true, makerWalletAddress: note.walletAddress },
    );
    expect(await service.ensureForMarket({ batchId: "other-market", marketId: "btc-usd-perp" }))
      .toEqual({ created: 0, skipped: 0 });
  });

  test("uses only required margin from a larger maker note", () => {
    const [allocation] = selectMakerNoteAllocations([note], payload);
    expect(allocation.margin).toBe(payload.margin);
    expect(allocation.size).toBe(payload.signedSize);
    expect(allocation.note.commitment).toBe(note.commitment);
  });

  test("creates deterministic spendable change for the unused note amount", () => {
    const change = buildMakerChangeNote(
      note,
      payload.margin,
      payload.intentCommitment,
    );
    expect(change?.amount).toBe("4990000000");
    expect(change?.status).toBe("available");
    expect(change?.commitment).toBe(
      secureMarginCommitment({
        amount: 4_990_000_000n,
        assetDigest: note.assetDigest,
        blinding: change!.blinding,
        ownerDigest: note.ownerDigest,
        rhoDigest: change!.rhoDigest,
        spendSecretDigest: change!.spendSecretDigest,
      }),
    );
    const repeated = buildMakerChangeNote(
      note,
      payload.margin,
      payload.intentCommitment,
    );
    expect(repeated?.commitment).toBe(change?.commitment);
    expect(repeated?.noteNullifier).toBe(change?.noteNullifier);

    const vaultedChange = buildMakerChangeNote(
      { ...note, vaultAllocationId: "vault:allocation" },
      payload.margin,
      payload.intentCommitment,
    );
    expect(vaultedChange?.vaultAllocationId).toBe("vault:allocation");
    expect(vaultedChange?.vaultParentCommitment).toBe(note.commitment);
    expect(vaultedChange?.token).toBe(note.token);

    const privateVariant = buildMakerChangeNote(
      { ...note, spendSecretDigest: hashFields("maker", ["another-private-spend"]) },
      payload.margin,
      payload.intentCommitment,
    );
    expect(privateVariant?.commitment).not.toBe(change?.commitment);
    expect(privateVariant?.noteNullifier).not.toBe(change?.noteNullifier);
  });

  test("combines smaller notes and returns change from the final note", () => {
    const requiredMargin = 6_000_000_000n;
    const allocations = selectMakerNoteAllocations(
      [
        makerNote("one", 2_500_000_000n),
        makerNote("two", 2_500_000_000n),
        makerNote("three", 2_500_000_000n),
      ],
      {
        ...payload,
        margin: requiredMargin,
        signedSize: 600_000_000n,
      },
    );

    expect(allocations.map((allocation) => allocation.margin)).toEqual([
      2_500_000_000n,
      2_500_000_000n,
      1_000_000_000n,
    ]);
    expect(allocations.reduce((sum, allocation) => sum + allocation.margin, 0n)).toBe(
      requiredMargin,
    );
    expect(allocations.reduce((sum, allocation) => sum + allocation.size, 0n)).toBe(
      600_000_000n,
    );
    expect(
      buildMakerChangeNote(
        allocations[2].note,
        allocations[2].margin,
        payload.intentCommitment,
      )?.amount,
    ).toBe("1500000000");
  });

  test("does not create change for an exact maker note", () => {
    expect(
      buildMakerChangeNote(
        { ...note, amount: payload.margin.toString() },
        payload.margin,
        payload.intentCommitment,
      ),
    ).toBeUndefined();
  });
});

function makerNote(label: string, amount: bigint) {
  return {
    ...note,
    amount: amount.toString(),
    blinding: hashFields("maker-blinding", [label]),
    commitment: hashFields("maker-note", [label]),
    noteNullifier: hashFields("maker-nullifier", [label]),
    rhoDigest: hashFields("maker-rho", [label]),
    spendSecretDigest: hashFields("maker-spend", [label]),
  };
}

describe("house maker price policy", () => {
  test("retries a quote only when it still crosses and remains favorable to the maker", () => {
    const buy = { signedSize: 1n, limitPrice: 10_100n };
    expect(makerPendingQuoteIsValid(buy, 10_050n, 10_000n)).toBe(true);
    expect(makerPendingQuoteIsValid(buy, 10_101n, 10_000n)).toBe(false);
    expect(makerPendingQuoteIsValid(buy, 9_999n, 10_000n)).toBe(false);
    const sell = { signedSize: -1n, limitPrice: 9_900n };
    expect(makerPendingQuoteIsValid(sell, 9_950n, 10_000n)).toBe(true);
    expect(makerPendingQuoteIsValid(sell, 9_899n, 10_000n)).toBe(false);
    expect(makerPendingQuoteIsValid(sell, 10_001n, 10_000n)).toBe(false);
    expect(makerPendingQuoteIsValid({ signedSize: 1n, limitPrice: 10_300n }, 10_201n, 10_000n)).toBe(false);
    expect(makerPendingQuoteIsValid({ signedSize: -1n, limitPrice: 9_700n }, 9_799n, 10_000n)).toBe(false);
  });

  test("quotes both sides from the reference rather than copying a client limit", () => {
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 101n }, 100n)).toBe(100n);
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 99n }, 100n)).toBe(100n);
  });

  test("rejects a non-crossing limit and an extreme limit on either side", () => {
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 99n }, 100n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 101n }, 100n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 1_000_000n }, 100n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 1n }, 100n)).toBeUndefined();
  });

  test("applies spread against the customer and uses conservative integer rounding", () => {
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 102n }, 101n, 25n)).toBe(102n);
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 100n }, 101n, 25n)).toBe(100n);
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 101n }, 101n, 25n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 101n }, 101n, 25n)).toBeUndefined();
  });

  test("enforces the exact two-percent client-price boundary", () => {
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 10_200n }, 10_000n)).toBe(10_000n);
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 10_201n }, 10_000n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 9_800n }, 10_000n)).toBe(10_000n);
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 9_799n }, 10_000n)).toBeUndefined();
  });

  test("rejects invalid reference/spread policies before quoting", () => {
    expect(() => makerQuoteForIntent({ signedSize: 1n, limitPrice: 100n }, 0n)).toThrow("invalid maker price policy");
    expect(() => makerQuoteForIntent({ signedSize: 1n, limitPrice: 100n }, 100n, -1n)).toThrow("invalid maker price policy");
    expect(() => makerQuoteForIntent({ signedSize: 1n, limitPrice: 100n }, 100n, 10_000n)).toThrow("invalid maker price policy");
  });
});

describe("maker collateral recovery", () => {
  test("reconciles an on-chain active maker order already marked cancelled locally", async () => {
    const fixture = cancelledMakerFixture();
    const blocked = await fixture.reconcile();
    expect(blocked.size).toBe(0);
    expect(fixture.cancellations()).toBe(1);
    expect(fixture.active()).toBe(false);
    expect(fixture.store.orderLifecycle.get(fixture.intentId)?.status).toBe("cancelled");
    expect((await fixture.reconcile()).size).toBe(0);
    expect(fixture.cancellations()).toBe(1);
  });

  test("keeps collateral unavailable if cancellation cannot be confirmed or the note was spent", async () => {
    const fixture = cancelledMakerFixture(true);
    const blocked = await fixture.reconcile();
    expect(blocked.has(fixture.note.commitment)).toBe(true);
    expect(fixture.cancellations()).toBe(0);
    expect(fixture.active()).toBe(true);
  });

  test("does not reuse an available note belonging to a locally open order", async () => {
    const fixture = cancelledMakerFixture();
    fixture.store.orderLifecycle.set(fixture.intentId, {
      ...fixture.store.orderLifecycle.get(fixture.intentId)!, status: "open",
    });
    expect((await fixture.reconcile()).has(fixture.note.commitment)).toBe(true);
    expect(fixture.cancellations()).toBe(0);
  });

  test("cancels an orphaned active maker order on-chain before releasing its note", async () => {
    const fixture = cancelledMakerFixture();
    const source = fieldHex(210n);
    fixture.store.orderLifecycle.set(source, { intentCommitment: source, batchId: "source", marketId: "xlm-usd-perp",
      ownerCommitment: fieldHex(211n), status: "cancelled", createdAt: 1, updatedAt: 2 });
    fixture.store.orderLifecycle.set(fixture.intentId, { ...fixture.store.orderLifecycle.get(fixture.intentId)!, status: "open" });
    fixture.onchain.isIntentActiveAsync = async (id?: Hex) => id === source ? false : fixture.active();
    fixture.onchain.isIntentCancelledAsync = async (id?: Hex) => id === source ? true : !fixture.active();
    const locked = { ...fixture.note, status: "locked" as const, lockedByIntentCommitment: fixture.intentId,
      sourceIntentCommitment: source };
    const result = await fixture.reap(locked);
    expect(fixture.cancellations()).toBe(1);
    expect(fixture.active()).toBe(false);
    expect(fixture.store.orderLifecycle.get(fixture.intentId)?.status).toBe("cancelled");
    expect(result.notes[0].status).toBe("available");
  });

  test("fences an unregistered maker submission before releasing a terminal source's note", async () => {
    for (const sourceStatus of ["cancelled", "filled", "partially-filled"] as const) {
      const fixture = orphanedMakerFixture(sourceStatus);
      const result = await fixture.reap();
      expect(result.changed).toBe(true);
      expect(result.notes[0].status).toBe("available");
      expect(fixture.fences()).toBe(1);
      expect(fixture.store.pendingIntentSubmissions.size).toBe(0);
    }
  });

  test("retains the maker note if the fence fails or the pending order becomes registered", async () => {
    for (const outcome of ["failed", "registered"] as const) {
      const fixture = orphanedMakerFixture("cancelled", outcome);
      const result = await fixture.reap();
      expect(result.changed).toBe(false);
      expect(result.notes[0].status).toBe("locked");
      expect(fixture.fences()).toBe(1);
      expect(fixture.store.pendingIntentSubmissions.size).toBe(1);
    }
  });

  test("recovers a locked note if the process stopped after removing its fenced journal", async () => {
    const fixture = orphanedMakerFixture("cancelled");
    fixture.store.pendingIntentSubmissions.clear();
    const result = await fixture.reap();
    expect(result.changed).toBe(true);
    expect(result.notes[0].status).toBe("available");
    expect(fixture.fences()).toBe(1);
  });
});

function cancelledMakerFixture(spent = false) {
  const wallet = "GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";
  const makerNote = { ...note, walletAddress: wallet, ownerCommitment: ownerCommitment(wallet) };
  const intentId = fieldHex(201n);
  const store = new ProtocolStore();
  store.intents.set(intentId, { intentCommitment: intentId, batchId: "maker-auto-test", marketId: "xlm-usd-perp",
    noteNullifier: makerNote.noteNullifier, ownerCommitment: makerNote.ownerCommitment } as IntentRecord);
  store.orderLifecycle.set(intentId, { intentCommitment: intentId, batchId: "maker-auto-test", marketId: "xlm-usd-perp",
    ownerCommitment: makerNote.ownerCommitment, status: "cancelled", createdAt: 1, updatedAt: 1 });
  let active = true;
  let cancellations = 0;
  const onchain = { enabled: true, isSecureNullifierSpentAsync: async () => spent,
    isIntentActiveAsync: async (_id?: Hex) => active, isIntentCancelledAsync: async (_id?: Hex) => !active,
    cancelIntentAsync: async () => {
      cancellations++;
      active = false;
      return { relays: [{ functionName: "cancel", submitted: true, txHash: fieldHex(202n) }] };
    } };
  const service = new MakerLiquidityService(new ExecutorService({}, store), {} as never, onchain as never,
    { intentRegistryOnchainRequired: true });
  return { store, note: makerNote, intentId, onchain, active: () => active, cancellations: () => cancellations,
    reconcile: () => Reflect.get(service, "reconcileCancelledMakerIntents").call(service, [makerNote]) as Promise<Set<Hex>>,
    reap: (locked: unknown) =>
      Reflect.get(service, "reapOrphanedMakerIntents").call(service, [locked]) as Promise<{changed: boolean; notes: Array<{status: string}>}> };
}

function orphanedMakerFixture(sourceStatus: "cancelled" | "filled" | "partially-filled", outcome: "success" | "failed" | "registered" = "success") {
  const wallet = "GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";
  const makerNote = { ...note, walletAddress: wallet, ownerCommitment: ownerCommitment(wallet), status: "locked" as const,
    lockedByIntentCommitment: fieldHex(301n), sourceIntentCommitment: fieldHex(302n) };
  type ReapedMakerNote = Omit<typeof makerNote, "status"> & { status: "locked" | "available" };
  const store = new ProtocolStore();
  store.orderLifecycle.set(makerNote.sourceIntentCommitment, { intentCommitment: makerNote.sourceIntentCommitment,
    batchId: "source", marketId: "xlm-usd-perp", ownerCommitment: fieldHex(303n), status: sourceStatus,
    ...(sourceStatus === "partially-filled" ? { residualCommitment: fieldHex(304n) } : {}), createdAt: 1, updatedAt: 2 });
  store.pendingIntentSubmissions.set(makerNote.lockedByIntentCommitment, {
    intentCommitment: makerNote.lockedByIntentCommitment, createdAt: 1,
    intent: { batchId: "maker-auto-test", owner: wallet, noteNullifier: makerNote.noteNullifier,
      nonce: `${makerNote.sourceIntentCommitment}:${makerNote.commitment}:maker-nonce`,
      salt: `${makerNote.sourceIntentCommitment}:${makerNote.commitment}:maker-salt` },
    validity: { noteCommitment: makerNote.commitment },
    prepared: { record: { intentCommitment: makerNote.lockedByIntentCommitment, ownerCommitment: makerNote.ownerCommitment } },
  } as never);
  let registered = false;
  let fences = 0;
  const onchain = { enabled: true, isIntentRegisteredAsync: async () => registered,
    isIntentActiveAsync: async () => false, isIntentCancelledAsync: async () => true,
    fenceIntentSubmissionAsync: async () => {
      fences++;
      if (outcome === "failed") throw new Error("fence unavailable");
      if (outcome === "registered") registered = true;
    } };
  const service = new MakerLiquidityService(new ExecutorService({}, store), {} as never, onchain as never,
    { intentRegistryOnchainRequired: true });
  return { store, fences: () => fences,
    reap: () => Reflect.get(service, "reapOrphanedMakerIntents").call(service, [makerNote]) as Promise<{changed: boolean; notes: ReapedMakerNote[]}> };
}

test("settlement replay preserves an existing child note in either store order", () => {
  const makerIntent = hashFields("maker-replay", ["intent"]);
  const sourceIntent = payload.intentCommitment;
  const parent = { ...note, status: "spent" as const,
    lockedByIntentCommitment: makerIntent, sourceIntentCommitment: sourceIntent };
  const change = buildMakerChangeNote(parent, payload.margin, sourceIntent)!;
  for (const status of ["spent", "locked", "draining", "withdrawing"] as const) {
    const child = { ...change, status };
    for (const notes of [[parent, child], [child, parent]]) {
      const result = finalizedMakerNotes(notes, new Set([makerIntent]), new Map([[makerIntent, payload]]));
      expect(result.filter((item) => item.commitment === child.commitment)).toEqual([child]);
      expect(result.find((item) => item.commitment === child.commitment)?.status).toBe(status);
    }
  }
});
