import { describe, expect, test } from "bun:test";
import type { CycleState, ProtocolState } from "./protocol";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./plan";
import { ObservationRunner, createCampaign, publicStatus, type CampaignState, type RunnerServices, type HealthSample, type OutboxEntry } from "./run";
import type { WalletRecord } from "./wallets";

const START = Date.parse("2026-10-30T09:00:00Z");
const HASH = "a".repeat(64);
const POSITION = `0x${"b".repeat(64)}` as const;
const OWNER = "0x1" as const;
const ASSET = "0x2" as const;

function emptyProtocol(wallet: WalletRecord): ProtocolState {
  return { version: 1, source: wallet.source, address: wallet.address, ownerCommitment: OWNER,
    collateralDigest: ASSET, notes: [], deposits: {}, cycles: {}, requests: [] };
}
function savedCycle(id: string, phase: CycleState["phase"] = "open"): CycleState {
  return {
    id, spec: { id, marketId: "xlm-usd-perp", margin: "100000000", leverage: 2, side: "long" },
    phase, noteCommitment: "0x3", intentCommitment: "0x4", intent: {},
    oraclePriceAtPreparation: "22000000", fundingIndexAtPreparation: "0",
    orders: [], activeOrders: [], matching: [], timings: { submissionStartedAt: START - 20 * MINUTE_MS, openedObservedAt: START - 10 * MINUTE_MS },
    positions: phase === "open" || phase === "closing" || phase === "closed" ? [{
      snapshot: { batchId: "batch-1", marketId: "xlm-usd-perp", openedAt: START - 30 * MINUTE_MS,
        positionCommitment: POSITION, settlementDigest: "0x5", settlementTxHash: HASH as `0x${string}`,
        sourceIntentCommitment: "0x4", status: phase === "closed" ? "closed" : "open", updatedAt: START },
      opening: { entryPrice: "22000000", fundingIndex: "0", margin: "100000000", marketId: "xlm-usd-perp",
        positionCommitment: POSITION, positionNullifier: "0x6", ownerDigest: "0x7", positionSeed: "0x8", fillIndex: 0,
        side: "long", size: "10000", sourceIntentCommitment: "0x4" },
      closes: [],
    }] : [],
  };
}

function harness(state = createCampaign({ runId: "test-campaign", seed: "test-seed", startAt: START }, true)) {
  let now = START;
  const actions: string[] = [];
  const checkpoints: CampaignState[] = [];
  const sent: OutboxEntry[] = [];
  let send: (entry: OutboxEntry) => Promise<{ id: string }> = async (entry) => {
    sent.push(structuredClone(entry)); return { id: "provider-test-id" };
  };
  let chainTime: number | undefined = START - 10 * MINUTE_MS;
  const health = (): HealthSample => ({ at: now, apiOk: true, proverOk: true,
    markets: [{ marketId: "xlm-usd-perp", maxLeverage: 2 }],
    budget: { at: now, chainId: 8453, creditWei: "10000000000000000", gasWei: "1000000000000000" } });
  const services: RunnerServices = {
    now: () => now, from: "PNLX <test@example.com>", to: "owner@example.com",
    persist: async (value) => { checkpoints.push(structuredClone(value)); },
    createWallet: (source) => { actions.push("create-wallet"); return { source, address: `GTEST${state.wallets.length}`, funding: [] }; },
    fund: async () => { actions.push("fund"); },
    health: async () => health(),
    sendEmail: (entry) => send(entry), chainTime: async () => chainTime,
    protocol(wallet, persist) {
      const data = structuredClone(wallet.protocol as ProtocolState | undefined ?? emptyProtocol(wallet));
      const save = async () => { await persist(structuredClone(data)); };
      const read = (id: string) => structuredClone(data.cycles[id]!);
      return {
        get state() { return structuredClone(data); },
        async pollOpen(id) { actions.push(`poll:${id}`); await save(); return read(id); },
        async pollClose(id) { actions.push(`poll-close:${id}`); await save(); return read(id); },
        async prepareDeposit(id, amount) { actions.push("prepare-deposit");
          data.deposits[id] = { id, amount, commitment: "0x9", phase: "ready", createdAt: now }; await save(); return structuredClone(data.deposits[id]!); },
        async submitDeposit(id) { actions.push("submit-deposit"); data.deposits[id]!.phase = "submitting"; await save(); return structuredClone(data.deposits[id]!); },
        async reconcileDeposit(id) { actions.push("reconcile-deposit"); data.deposits[id]!.phase = "confirmed";
          data.notes.push({ amount: data.deposits[id]!.amount, assetDigest: ASSET, ownerCommitment: OWNER,
            walletAddress: wallet.address, status: "available", blinding: "0x1", commitment: "0x9", noteNullifier: "0x1",
            ownerDigest: "0x1", rhoDigest: "0x1", spendSecretDigest: "0x1" }); await save(); return structuredClone(data.deposits[id]!); },
        async prepareOpen(spec) { actions.push(`prepare-open:${spec.leverage}`);
          data.cycles[spec.id] = { ...(data.cycles[spec.id] ?? savedCycle(spec.id)), phase: "ready", spec };
          delete data.cycles[spec.id]!.marginRootRetryPending; delete data.cycles[spec.id]!.retryAfterAt;
          await save(); return read(spec.id); },
        async open(id) { actions.push("submit-open"); data.cycles[id]!.phase = "accepted"; await save(); return read(id); },
        async prepareClose(id) { actions.push("prepare-close"); data.cycles[id]!.phase = "closing";
          data.cycles[id]!.positions[0]!.closes.push({ phase: "ready", closeCommitment: "0xa", witness: {}, output: {} as any,
            createdAt: now, markPrice: "23000000", fundingIndex: "0", fundingPayment: "0", realizedPnl: "100", returnedMargin: "100000100" });
          await save(); return read(id); },
        async close(id) { actions.push("submit-close"); data.cycles[id]!.positions[0]!.closes.at(-1)!.phase = "submitting"; await save(); return read(id); },
        async cancelOpen(id) { actions.push("cancel-open"); data.cycles[id]!.activeOrders = []; await save(); return read(id); },
        async recoverCash(id) { actions.push("recover-cash"); data.cycles[id]!.cashReconciled = true;
          if (data.cycles[id]!.positions.every((position) => position.snapshot.status !== "open")) data.cycles[id]!.phase = "closed";
          await save(); return read(id); },
      };
    },
  };
  return { state, services, actions, checkpoints, sent, now: (value: number) => { now = value; },
    send: (value: typeof send) => { send = value; }, chainTime: (value: number | undefined) => { chainTime = value; },
    runner: () => new ObservationRunner(state, services), health };
}

function attachActive(h: ReturnType<typeof harness>, index = 0, phase: CycleState["phase"] = "open") {
  const cycle = h.state.cycles[index]!;
  cycle.status = "active"; cycle.startedAt = START - 20 * MINUTE_MS; cycle.lastProgressAt = cycle.startedAt;
  cycle.plan = { ...cycle.plan, holdDurationMs: 5 * MINUTE_MS };
  const wallet: WalletRecord = { source: `pnlx-observation-test-${index}`, address: `GTEST${index}`, funding: [] };
  cycle.walletSource = wallet.source;
  const data = emptyProtocol(wallet);
  const value = savedCycle(cycle.adapterId, phase);
  data.cycles[cycle.adapterId] = value; wallet.protocol = data; h.state.wallets.push(wallet);
  return { cycle, wallet, data, value };
}

describe("one-time observation runner", () => {
  test("initialization persists a fixed 140-cycle campaign and performs no actions", async () => {
    const h = harness();
    expect(h.state.cycles).toHaveLength(140);
    expect(h.state.plan.endsAt - h.state.plan.startAt).toBe(7 * DAY_MS);
    expect(h.state.cycles.every((cycle) => /^[A-Za-z0-9_-]{1,100}$/.test(cycle.adapterId))).toBe(true);
    expect(h.actions).toEqual([]);
    await h.runner().boot();
    expect(h.state.bootCount).toBe(1);
    expect(h.sent).toEqual([]);
    expect(h.actions).toEqual([]);
  });

  test("the explicit five-minute pilot preserves day-one distributions", () => {
    const state = createCampaign({ runId: "pilot-distributions", seed: "deterministic", startAt: START }, true);
    const first = state.cycles[0]!.plan;
    expect([first.market, first.side, first.marginUsdc, first.leverage, first.holdClass, first.holdDurationMs, first.plannedOpenAt])
      .toEqual(["XLM", "long", 10, 1, "short", 5 * MINUTE_MS, START]);
    const day = state.cycles.filter((cycle) => cycle.plan.day === 1);
    expect(day.filter((cycle) => cycle.plan.holdClass === "short")).toHaveLength(12);
    expect(day.filter((cycle) => cycle.plan.holdClass === "medium")).toHaveLength(6);
    expect(day.filter((cycle) => cycle.plan.holdClass === "long")).toHaveLength(2);
    for (const margin of [10, 25, 50, 100]) expect(day.filter((cycle) => cycle.plan.marginUsdc === margin)).toHaveLength(5);
    for (const leverage of [1, 2, 3, 5, 8]) expect(day.filter((cycle) => cycle.plan.leverage === leverage)).toHaveLength(4);
  });

  test("confirmed due closes precede new funding even with an exhausted proof budget", async () => {
    const h = harness(); const active = attachActive(h);
    h.services.health = async () => ({ ...h.health(), budget: { at: START, chainId: 8453, creditWei: "0", gasWei: "0" } });
    await h.runner().tick();
    expect(h.actions).toContain("prepare-close");
    expect(h.actions).toContain("submit-close");
    expect(h.actions.indexOf("submit-close")).toBe(h.actions.indexOf("prepare-close") + 1);
    expect(h.actions).not.toContain("fund");
    expect(h.actions).not.toContain("create-wallet");
    expect(active.cycle.openings[POSITION]!.at).toBe(START - 10 * MINUTE_MS);
    expect(active.cycle.openings[POSITION]!.source).toBe("chain");
    const opened = h.state.outbox.find((entry) => entry.data.kind === "opened")!;
    expect(opened.data.entryPrice).toBe("$0.22");
    expect(opened.data.holdingDurationMs).toBeUndefined();
  });

  test("holds start at confirmed observation when Horizon is unavailable, not pre-proof snapshot time", async () => {
    const h = harness(); const { cycle, value } = attachActive(h);
    value.timings.openedObservedAt = START - MINUTE_MS;
    h.chainTime(undefined);
    await h.runner().tick();
    expect(cycle.openings[POSITION]).toEqual({ at: START - MINUTE_MS, source: "observed" });
    expect(h.actions).not.toContain("prepare-close");
    expect(h.state.outbox.find((entry) => entry.data.kind === "opened")!.data.message).toContain("confirmed observation");
  });

  test("opening timings recover historical run IDs and select the settled run bound to the confirmed settlement", async () => {
    const h = harness(); const { value } = attachActive(h);
    const winningId = `0x${"1".repeat(64)}` as const;
    const failedId = `0x${"2".repeat(64)}` as const;
    const wrongSettlementId = `0x${"3".repeat(64)}` as const;
    const unrelatedId = `0x${"4".repeat(64)}` as const;
    const digest = `0x${"a".repeat(64)}` as const;
    value.positions[0]!.snapshot.settlementDigest = digest;
    value.matching = [
      { observedAt: START - 15 * MINUTE_MS, intentCommitment: "0x4", matching: {
        batchId: "batch-1", runId: failedId, state: "proving", phase: "proving", status: "running", message: "Proving" } },
      { observedAt: START - 14 * MINUTE_MS, intentCommitment: "0x4", matching: {
        batchId: "batch-1", runId: wrongSettlementId, state: "proving", phase: "proving", status: "running", message: "Proving" } },
      { observedAt: START - 13 * MINUTE_MS, intentCommitment: "0x4", matching: {
        batchId: "another-batch", runId: unrelatedId, state: "proving", phase: "proving", status: "running", message: "Proving" } },
      { observedAt: START - 12 * MINUTE_MS, intentCommitment: "0x4", matching: {
        batchId: "batch-1", runId: winningId, state: "proving", phase: "proving", status: "running", message: "Proving" } },
      { observedAt: START - 10 * MINUTE_MS, intentCommitment: "0x4", matching: {
        state: "settled", message: "Order no longer active" } },
    ];
    let requested: string[] = [];
    h.services.executionRuns = async (ids) => {
      requested = ids;
      return [
        { runId: failedId, batchId: "batch-1", status: "failed", settlementDigest: digest,
          startedAt: START - 16 * MINUTE_MS, completedAt: START - 15 * MINUTE_MS,
          phaseTimestamps: { proving: START - 16 * MINUTE_MS, "batch-settlement": START - 15 * MINUTE_MS } },
        { runId: wrongSettlementId, batchId: "batch-1", status: "settled", settlementDigest: "0xdead",
          startedAt: START - 15 * MINUTE_MS, completedAt: START - 14 * MINUTE_MS,
          phaseTimestamps: { proving: START - 15 * MINUTE_MS, "batch-settlement": START - 14 * MINUTE_MS } },
        { runId: winningId, batchId: "batch-1", status: "settled", settlementDigest: digest.toUpperCase(),
          startedAt: START - 13 * MINUTE_MS, completedAt: START - 10 * MINUTE_MS,
          phaseTimestamps: { proving: START - 12 * MINUTE_MS, "batch-settlement": START - 11 * MINUTE_MS } },
      ];
    };
    await h.runner().tick();
    expect(new Set(requested)).toEqual(new Set([failedId, wrongSettlementId, winningId]));
    expect(requested).not.toContain(unrelatedId);
    const opened = h.state.outbox.find((entry) => entry.data.kind === "opened")!.data;
    expect(opened.matchedAt).toBe(new Date(START - 12 * MINUTE_MS).toISOString());
    expect(opened.proofStartedAt).toBe(new Date(START - 12 * MINUTE_MS).toISOString());
    expect(opened.proofCompletedAt).toBe(new Date(START - 11 * MINUTE_MS).toISOString());
  });

  test("completed or unbound execution runs supply no invented opening proof timings", async () => {
    const h = harness(); const { value } = attachActive(h);
    const runId = `0x${"1".repeat(64)}` as const;
    value.matching.push({ observedAt: START - 12 * MINUTE_MS, intentCommitment: "0x4", matching: {
      batchId: "batch-1", runId, state: "proving", status: "running", message: "Proving" } });
    h.services.executionRuns = async () => [{ runId, batchId: "batch-1", status: "failed", settlementDigest: value.positions[0]!.snapshot.settlementDigest,
      startedAt: START - 13 * MINUTE_MS, completedAt: START - 10 * MINUTE_MS,
      phaseTimestamps: { proving: START - 12 * MINUTE_MS, "batch-settlement": START - 11 * MINUTE_MS } }];
    await h.runner().tick();
    const opened = h.state.outbox.find((entry) => entry.data.kind === "opened")!.data;
    expect(opened.matchedAt).toBeUndefined();
    expect(opened.proofStartedAt).toBeUndefined();
    expect(opened.proofCompletedAt).toBeUndefined();
  });

  test("uncertain close submissions are observed and never resubmitted or rebuilt", async () => {
    const h = harness(); const { value } = attachActive(h, 0, "closing");
    value.positions[0]!.closes.push({ phase: "uncertain", closeCommitment: "0xa", witness: {}, output: {} as any,
      createdAt: START - MINUTE_MS, markPrice: "0", fundingIndex: "0", fundingPayment: "0", realizedPnl: "0", returnedMargin: "0" });
    await h.runner().tick();
    expect(h.actions.some((action) => action.startsWith("poll-close"))).toBe(true);
    expect(h.actions).not.toContain("prepare-close");
    expect(h.actions).not.toContain("submit-close");
    expect(h.actions).not.toContain("fund");
    expect(h.state.pausedReason).toContain("uncertain");
  });

  test("a confirmed failed-close transition clears stale alerts and closes before new opens", async () => {
    const h = harness(); const { cycle, wallet, value } = attachActive(h, 0, "closing");
    value.positions[0]!.closes.push({ phase: "uncertain", closeCommitment: "0xa", witness: {}, output: {} as any,
      createdAt: START - MINUTE_MS, markPrice: "0", fundingIndex: "0", fundingPayment: "0", realizedPnl: "0", returnedMargin: "0" });
    await h.runner().tick();
    cycle.failureAlertedAt = START - MINUTE_MS; cycle.stallAlertedAt = START - MINUTE_MS;
    const saved = (wallet.protocol as ProtocolState).cycles[cycle.adapterId]!;
    saved.positions[0]!.closes[0]!.phase = "context-rejected";
    saved.positions[0]!.closes[0]!.failedTransaction = { txHash: `0x${"c".repeat(64)}`, observedAt: START };
    await h.runner().tick();
    expect(cycle.failureAlertedAt).toBeUndefined(); expect(cycle.stallAlertedAt).toBeUndefined();
    expect(h.actions).toContain("prepare-close"); expect(h.actions).toContain("submit-close");
    expect(h.actions).not.toContain("fund"); expect(h.actions).not.toContain("submit-open");
    const attempts = (wallet.protocol as ProtocolState).cycles[cycle.adapterId]!.positions[0]!.closes;
    expect(attempts[0]!.phase).toBe("context-rejected");
    expect(attempts[0]!.failedTransaction?.txHash).toBe(`0x${"c".repeat(64)}`);
    expect(attempts[1]!.phase).toBe("submitting");
  });

  test("another uncertain operation preserves failure alerts after one close recovers", async () => {
    const h = harness(); const { cycle, value } = attachActive(h, 0, "closing");
    h.state.pausedReason = "An existing execution is stalled or uncertain.";
    cycle.failureAlertedAt = START - MINUTE_MS; cycle.stallAlertedAt = START - MINUTE_MS;
    value.positions[0]!.closes.push({ phase: "context-rejected", closeCommitment: "0xa", witness: {}, output: {} as any,
      failedTransaction: { txHash: `0x${"c".repeat(64)}`, observedAt: START },
      createdAt: START - MINUTE_MS, markPrice: "0", fundingIndex: "0", fundingPayment: "0", realizedPnl: "0", returnedMargin: "0" });
    value.cancellations = { "0x4": { phase: "uncertain", submittedAt: START - MINUTE_MS } };
    await h.runner().tick();
    expect(cycle.failureAlertedAt).toBeDefined(); expect(cycle.stallAlertedAt).toBeDefined();
    expect(h.actions).not.toContain("submit-open"); expect(h.state.pausedReason).toContain("uncertain");
  });

  test("reconciles uncertain deposits before pause gating, then resumes saved preparation", async () => {
    const h = harness(); const { cycle, data } = attachActive(h, 0, "preparing");
    delete data.cycles[cycle.adapterId];
    data.deposits[cycle.depositId] = { id: cycle.depositId, amount: "1000000000", commitment: "0x9", phase: "uncertain", createdAt: START - MINUTE_MS };
    cycle.fundingChecked = true;
    await h.runner().tick();
    expect(h.actions[0]).toBe("reconcile-deposit");
    expect(h.actions.some((action) => action.startsWith("prepare-open"))).toBe(true);
    expect(h.actions).not.toContain("submit-deposit");
    expect(h.state.pausedReason).toBeUndefined();
  });

  test("stale-root recovery holds new opens during backoff, then retries the saved preparation once", async () => {
    const h = harness();
    const { cycle, wallet, value } = attachActive(h, 0, "preparing");
    const savedValue = () => (wallet.protocol as ProtocolState).cycles[cycle.adapterId]!;
    cycle.fundingChecked = true;
    value.marginRootRetryPending = true;
    value.marginRootRetryCount = 1;
    value.retryAfterAt = START + MINUTE_MS;
    cycle.failureAlertedAt = START - MINUTE_MS;
    cycle.stallAlertedAt = START - MINUTE_MS;
    h.state.pausedReason = "An existing execution is stalled or uncertain.";

    await h.runner().tick();

    expect(h.actions).toEqual([`poll:${cycle.adapterId}`]);
    expect(h.state.pausedReason).toContain("uncertain");
    expect(h.actions).not.toContain("create-wallet");
    expect(h.actions).not.toContain("fund");

    h.now(START + MINUTE_MS);
    await h.runner().tick();

    expect(h.actions.filter((action) => action === `prepare-open:${value.spec.leverage}`)).toHaveLength(1);
    expect(savedValue().phase).toBe("ready");
    expect(savedValue().marginRootRetryPending).toBeUndefined();
    expect(h.actions).not.toContain("create-wallet");
    expect(h.actions).not.toContain("fund");

    await h.runner().tick();

    expect(h.actions.filter((action) => action === "submit-open")).toHaveLength(1);
    expect(h.state.cycles.filter((entry) => entry.status === "active")).toHaveLength(1);
  });

  test("a transient deposit preparation failure resumes the same cycle without new funding", async () => {
    const h = harness(); const { cycle, wallet, data } = attachActive(h, 0, "preparing");
    delete data.cycles[cycle.adapterId]; cycle.fundingChecked = true;
    const protocol = h.services.protocol;
    let attempts = 0;
    h.services.protocol = (wallet, persist) => {
      const client = protocol(wallet, persist); const prepare = client.prepareDeposit.bind(client);
      client.prepareDeposit = async (id, amount) => {
        if (++attempts === 1) throw new Error("temporary preparation outage");
        return prepare(id, amount);
      };
      return client;
    };
    const runner = h.runner();
    await runner.tick();
    expect(cycle.failureAlertedAt).toBe(START);
    expect((wallet.protocol as ProtocolState).deposits[cycle.depositId]).toBeUndefined();
    h.now(START + MINUTE_MS);
    await runner.tick();
    const saved = wallet.protocol as ProtocolState;
    expect(attempts).toBe(2);
    expect(Object.keys(saved.deposits)).toEqual([cycle.depositId]);
    expect(saved.deposits[cycle.depositId]!.phase).toBe("submitting");
    expect(cycle.failureAlertedAt).toBeDefined();
    await runner.tick();
    expect(cycle.failureAlertedAt).toBeUndefined();
    expect(cycle.lastProgressAt).toBe(START + MINUTE_MS);
    expect(cycle.error).toContain("temporary preparation outage");
    expect(h.state.outbox.filter((entry) => entry.data.kind === "failed")).toHaveLength(1);
    expect(h.actions).toEqual(["prepare-deposit", "submit-deposit", "reconcile-deposit", "prepare-open:1"]);
    expect(h.state.wallets).toHaveLength(1);
  });

  test("a saved ready deposit resumes once and retains alerts until submission is reconciled", async () => {
    const h = harness(); const { cycle, wallet, data } = attachActive(h, 0, "preparing");
    delete data.cycles[cycle.adapterId]; cycle.fundingChecked = true;
    cycle.failureAlertedAt = START - MINUTE_MS; cycle.stallAlertedAt = START - MINUTE_MS;
    data.deposits[cycle.depositId] = { id: cycle.depositId, amount: "1000000000", commitment: "0x9", phase: "ready", createdAt: START - MINUTE_MS };
    const runner = h.runner();
    await runner.tick();
    expect(h.actions).toEqual(["submit-deposit"]);
    expect((wallet.protocol as ProtocolState).deposits[cycle.depositId]!.phase).toBe("submitting");
    expect(cycle.failureAlertedAt).toBeDefined(); expect(cycle.stallAlertedAt).toBeDefined();
    await runner.tick();
    expect(h.actions.filter((action) => action === "submit-deposit")).toHaveLength(1);
    expect(h.actions).toContain("reconcile-deposit");
    expect(h.actions.some((action) => action.startsWith("prepare-open"))).toBe(true);
    expect(h.actions).not.toContain("prepare-deposit"); expect(h.actions).not.toContain("fund");
    expect(cycle.failureAlertedAt).toBeUndefined(); expect(cycle.stallAlertedAt).toBeUndefined();
  });

  test("saved intent preparation reuses its locked note and original terms after interruption", async () => {
    const h = harness(); const { cycle, wallet, data, value } = attachActive(h, 0, "preparing");
    value.spec = { ...value.spec, margin: "1000000000", leverage: 8, side: "short" };
    value.intentCommitment = "0x123"; value.intent = { saved: "authorized intent" };
    cycle.progressFingerprint = JSON.stringify(["preparing", [], [], [], undefined, undefined]);
    cycle.failureAlertedAt = START - MINUTE_MS; cycle.stallAlertedAt = START - MINUTE_MS;
    data.notes.push({ amount: "1000000000", assetDigest: ASSET, ownerCommitment: OWNER,
      walletAddress: wallet.address, status: "locked", lockedByIntentCommitment: value.intentCommitment,
      blinding: "0x1", commitment: value.noteCommitment, noteNullifier: "0x1", ownerDigest: "0x1", rhoDigest: "0x1", spendSecretDigest: "0x1" });
    const original = structuredClone(value);
    await h.runner().tick();
    const saved = (wallet.protocol as ProtocolState).cycles[cycle.adapterId]!;
    expect(h.actions).toEqual([`poll:${cycle.adapterId}`, "prepare-open:8"]);
    expect(saved.phase).toBe("ready"); expect(saved.spec).toEqual(original.spec);
    expect(saved.intentCommitment).toBe(original.intentCommitment); expect(saved.intent).toEqual(original.intent);
    expect(saved.noteCommitment).toBe(original.noteCommitment);
    expect((wallet.protocol as ProtocolState).notes[0]!.status).toBe("locked");
    expect(cycle.failureAlertedAt).toBeUndefined(); expect(cycle.stallAlertedAt).toBeUndefined();
  });

  test("a successful preparation call without durable progress does not clear alerts", async () => {
    const h = harness(); const { cycle, data } = attachActive(h, 0, "preparing");
    delete data.cycles[cycle.adapterId]; cycle.fundingChecked = true;
    cycle.failureAlertedAt = START - MINUTE_MS;
    const deposit = { id: cycle.depositId, amount: "1000000000", commitment: "0x9" as const, phase: "preparing" as const, createdAt: START - MINUTE_MS };
    data.deposits[cycle.depositId] = deposit;
    const protocol = h.services.protocol;
    h.services.protocol = (wallet, persist) => {
      const client = protocol(wallet, persist);
      client.prepareDeposit = async () => { h.actions.push("prepare-deposit"); return structuredClone(deposit); };
      return client;
    };
    await h.runner().tick();
    expect(h.actions).toEqual(["prepare-deposit"]);
    expect(cycle.failureAlertedAt).toBe(START - MINUTE_MS);
    expect(cycle.lastProgressAt).toBe(START - 20 * MINUTE_MS);
    expect(h.state.pausedReason).toContain("uncertain");
  });

  test("first observation of unchanged saved intent preparation retains its failure alert", async () => {
    const h = harness(); const { cycle, wallet, value } = attachActive(h, 0, "preparing");
    cycle.failureAlertedAt = START - MINUTE_MS;
    const protocol = h.services.protocol;
    h.services.protocol = (wallet, persist) => {
      const client = protocol(wallet, persist);
      client.prepareOpen = async () => { h.actions.push("prepare-open-failed"); throw new Error("proof binding mismatch"); };
      return client;
    };
    await h.runner().tick();
    expect(h.actions).toEqual([`poll:${cycle.adapterId}`, "prepare-open-failed"]);
    expect(cycle.failureAlertedAt).toBe(START - MINUTE_MS);
    expect(cycle.error).toContain("proof binding mismatch");
    expect((wallet.protocol as ProtocolState).cycles[cycle.adapterId]!.intentCommitment).toBe(value.intentCommitment);
    expect(h.state.outbox.some((entry) => entry.data.kind === "resumed")).toBe(false);
  });

  test("uncertain deposits remain reconciliation-only when confirmation is unavailable", async () => {
    const h = harness(); const { cycle, data } = attachActive(h, 0, "preparing");
    delete data.cycles[cycle.adapterId]; cycle.fundingChecked = true; cycle.failureAlertedAt = START - MINUTE_MS;
    data.deposits[cycle.depositId] = { id: cycle.depositId, amount: "1000000000", commitment: "0x9", phase: "uncertain", createdAt: START - MINUTE_MS };
    const protocol = h.services.protocol;
    h.services.protocol = (wallet, persist) => {
      const client = protocol(wallet, persist);
      client.reconcileDeposit = async (id) => { h.actions.push("reconcile-deposit"); return client.state.deposits[id]!; };
      return client;
    };
    await h.runner().tick();
    expect(h.actions).toEqual(["reconcile-deposit"]);
    expect(cycle.failureAlertedAt).toBe(START - MINUTE_MS);
    expect(h.state.pausedReason).toContain("uncertain");
  });

  test("a safely replaced failed deposit clears its own alert and resumes its saved ID after restart", async () => {
    const h = harness(); const { cycle, wallet, data } = attachActive(h, 0, "preparing");
    delete data.cycles[cycle.adapterId]; cycle.fundingChecked = true;
    cycle.failureAlertedAt = START - MINUTE_MS; cycle.stallAlertedAt = START - MINUTE_MS;
    data.deposits[cycle.depositId] = { id: cycle.depositId, amount: "1000000000", commitment: "0x9", phase: "uncertain", createdAt: START - MINUTE_MS };
    const protocol = h.services.protocol;
    h.services.protocol = (wallet, persist) => {
      const client = protocol(wallet, persist);
      client.reconcileDeposit = async (id) => {
        h.actions.push("reconcile-deposit");
        const snapshot = client.state; const deposit = snapshot.deposits[id]!;
        deposit.phase = "preparing"; deposit.commitment = "0x10";
        await persist(snapshot); return structuredClone(deposit);
      };
      return client;
    };
    h.services.health = async () => ({ ...h.health(), apiOk: false });
    await h.runner().tick();
    expect(h.actions).toEqual(["reconcile-deposit"]);
    expect(cycle.failureAlertedAt).toBeUndefined(); expect(cycle.stallAlertedAt).toBeUndefined();
    expect((wallet.protocol as ProtocolState).deposits[cycle.depositId]!.phase).toBe("preparing");
    h.services.protocol = protocol; h.services.health = async () => h.health(); h.now(START + 2 * MINUTE_MS);
    await h.runner().tick();
    expect(h.actions).toEqual(["reconcile-deposit", "prepare-deposit", "submit-deposit"]);
    expect(Object.keys((wallet.protocol as ProtocolState).deposits)).toEqual([cycle.depositId]);
    expect(h.actions.filter((action) => action === "submit-deposit")).toHaveLength(1);
    expect(h.actions).not.toContain("fund");
  });

  for (const blocker of ["uncertain", "historical-alert"] as const) {
    test(`another cycle's ${blocker} blocks retrying a saved preparation`, async () => {
      const h = harness(); const { cycle, data } = attachActive(h, 0, "preparing");
      delete data.cycles[cycle.adapterId]; cycle.fundingChecked = true; cycle.failureAlertedAt = START - MINUTE_MS;
      data.deposits[cycle.depositId] = { id: cycle.depositId, amount: "1000000000", commitment: "0x9", phase: "ready", createdAt: START - MINUTE_MS };
      const other = attachActive(h, 1, blocker === "uncertain" ? "uncertain" : "accepted");
      other.cycle.progressFingerprint = JSON.stringify([other.value.phase, [], [], [], undefined, undefined]);
      if (blocker === "historical-alert") other.cycle.failureAlertedAt = START - MINUTE_MS;
      await h.runner().tick();
      expect(h.actions).toEqual([`poll:${other.cycle.adapterId}`]);
      expect(cycle.failureAlertedAt).toBeDefined(); expect(h.state.pausedReason).toContain("uncertain");
    });
  }

  for (const unavailable of ["health", "budget"] as const) {
    test(`saved preparation recovery still requires ${unavailable}`, async () => {
      const h = harness(); const { cycle, data } = attachActive(h, 0, "preparing");
      delete data.cycles[cycle.adapterId]; cycle.fundingChecked = true; cycle.failureAlertedAt = START - MINUTE_MS;
      data.deposits[cycle.depositId] = { id: cycle.depositId, amount: "1000000000", commitment: "0x9", phase: "ready", createdAt: START - MINUTE_MS };
      h.services.health = async () => unavailable === "health" ? { ...h.health(), apiOk: false } :
        { ...h.health(), budget: { at: START, chainId: 8453, creditWei: "0", gasWei: "0" } };
      await h.runner().tick();
      expect(h.actions).toEqual([]); expect(cycle.failureAlertedAt).toBeDefined();
    });
  }

  test("fresh deposit preparation is durable and submitted in the same tick, then restart only reconciles", async () => {
    const h = harness(); const runner = h.runner();
    await runner.tick();
    expect(h.actions).toEqual(["create-wallet", "fund"]);
    expect(h.checkpoints.some((state) => state.cycles[0]!.status === "active" && Boolean(state.wallets[0]?.protocol))).toBe(true);
    h.actions.length = 0;
    await runner.tick();
    expect(h.actions).toEqual(["prepare-deposit", "submit-deposit"]);
    const cycle = h.state.cycles[0]!;
    const ready = h.checkpoints.findIndex((state) =>
      (state.wallets[0]?.protocol as ProtocolState | undefined)?.deposits[cycle.depositId]?.phase === "ready");
    const submitting = h.checkpoints.findIndex((state) =>
      (state.wallets[0]?.protocol as ProtocolState | undefined)?.deposits[cycle.depositId]?.phase === "submitting");
    expect(ready).toBeGreaterThanOrEqual(0); expect(submitting).toBeGreaterThan(ready);
    h.actions.length = 0;
    await h.runner().tick();
    expect(h.actions).toEqual(["reconcile-deposit", "prepare-open:1"]);
    expect(h.state.cycles.filter((cycle) => cycle.status === "active")).toHaveLength(1);
  });

  test("a lost immediate deposit submission response never submits a second envelope", async () => {
    const h = harness(); const protocol = h.services.protocol;
    h.services.protocol = (wallet, persist) => {
      const client = protocol(wallet, persist); const submit = client.submitDeposit.bind(client);
      client.submitDeposit = async (id) => { await submit(id); throw new Error("deposit response unavailable"); };
      return client;
    };
    const runner = h.runner();
    await runner.tick(); await runner.tick();
    const cycle = h.state.cycles[0]!; const wallet = h.state.wallets[0]!;
    expect((wallet.protocol as ProtocolState).deposits[cycle.depositId]!.phase).toBe("submitting");
    expect(cycle.failureAlertedAt).toBeDefined();
    await h.runner().tick();
    expect(h.actions.filter((action) => action === "prepare-deposit")).toHaveLength(1);
    expect(h.actions.filter((action) => action === "submit-deposit")).toHaveLength(1);
    expect(h.actions).toContain("reconcile-deposit"); expect(cycle.failureAlertedAt).toBeUndefined();
  });

  test("a fresh campaign reuses a reconciled carried-forward wallet and private note without funding again", async () => {
    const h = harness();
    const wallet: WalletRecord = { source: "pnlx-observation-archived-wallet", address: "GCARRIED", funding: [] };
    const data = emptyProtocol(wallet);
    data.cycles["archived-cancelled"] = { ...savedCycle("archived-cancelled", "cancelled"), cashReconciled: true };
    data.notes.push({ amount: "1000000000", assetDigest: ASSET, ownerCommitment: OWNER,
      walletAddress: wallet.address, status: "available", blinding: "0x1", commitment: "0x9", noteNullifier: "0x1",
      ownerDigest: "0x1", rhoDigest: "0x1", spendSecretDigest: "0x1" });
    wallet.protocol = data; h.state.wallets.push(wallet);
    await h.runner().tick();
    expect(h.actions).toEqual(["prepare-open:1"]);
    expect(h.state.wallets).toHaveLength(1);
    expect(h.state.cycles[0]!.walletSource).toBe(wallet.source);
    expect((wallet.protocol as ProtocolState).cycles["archived-cancelled"]!.cashReconciled).toBe(true);
  });

  test("expired slots are missed without a catch-up burst; the open gap and concurrency cap survive restart", async () => {
    const h = harness(); h.now(START + 5 * HOUR_MS);
    h.state.lastNewOpenAt = START + 5 * HOUR_MS - MINUTE_MS;
    await h.runner().tick();
    expect(h.state.cycles.some((cycle) => cycle.status === "missed")).toBe(true);
    expect(h.actions).not.toContain("create-wallet");
    expect(h.state.outbox.some((entry) => entry.data.message?.includes("missed"))).toBe(true);
    const limited = harness();
    for (let index = 0; index < 3; index += 1) {
      const { cycle, value } = attachActive(limited, index);
      cycle.plan = { ...cycle.plan, holdDurationMs: 12 * HOUR_MS };
      value.timings.openedObservedAt = START - MINUTE_MS;
    }
    await limited.runner().tick();
    expect(limited.actions).not.toContain("create-wallet");
    expect(limited.state.wallets).toHaveLength(3);
  });

  test("after the cutoff existing positions still close and no new order is submitted", async () => {
    const h = harness(); attachActive(h); h.now(h.state.plan.endsAt + HOUR_MS);
    await h.runner().tick();
    expect(h.actions).toContain("prepare-close");
    expect(h.actions).not.toContain("submit-open");
    expect(h.state.completedAt).toBeUndefined();
  });

  test("closed wallets remain reserved until cash reconciliation completes", async () => {
    const h = harness(); const { cycle, value } = attachActive(h, 0, "closed");
    value.positions = []; value.cashReconciled = false;
    await h.runner().tick();
    expect(h.actions).toContain("recover-cash");
    expect(cycle.status).toBe("active");
    await h.runner().tick();
    expect(cycle.status).toBe("closed");
  });

  test("recovers cancelled residual collateral when a stale open phase has no open position", async () => {
    const h = harness(); const { cycle, value } = attachActive(h);
    cycle.failureAlertedAt = START - MINUTE_MS;
    value.positions[0]!.snapshot.status = "closed";
    value.positions[0]!.snapshot.lifecycleTxHash = HASH as `0x${string}`;
    value.positions[0]!.confirmedClose = { closeCommitment: "0xa", settlementTxHash: HASH,
      markPrice: "23000000", netPnl: "0", fundingPayment: "0", entryFee: "0", closeFee: "0",
      grossPricePnl: "0", returnedMargin: "100000000", pairedPayoutAdjustment: "0", payoutCapped: false, accountingComplete: true };
    value.orders = [{ batchId: "batch-1", createdAt: START, intentCommitment: "0x10", isResidual: true,
      matching: { message: "Order cancelled", state: "settled" }, matchingPayloadCommitment: "0x11",
      marketId: "xlm-usd-perp", status: "cancelled", updatedAt: START }];
    value.activeOrders = [];
    value.cashReconciled = false;
    await h.runner().tick();
    expect(h.actions).toContain("recover-cash");
    expect(h.actions).not.toContain("submit-open");
    await h.runner().tick();
    expect(cycle.status).toBe("closed");
    expect(h.state.pausedReason).toBeUndefined();
  });

  test("close emails use the winning close timestamps and verified net cash P&L", async () => {
    const h = harness(); const { value } = attachActive(h, 0, "closed");
    const closeHash = "c".repeat(64);
    value.cashReconciled = true;
    value.positions[0]!.snapshot.lifecycleTxHash = closeHash as `0x${string}`;
    value.positions[0]!.confirmedClose = { closeCommitment: "0xa", settlementTxHash: closeHash,
      markPrice: "23000000", netPnl: "4999999", fundingPayment: "100", entryFee: "1000", closeFee: "0",
      grossPricePnl: "5001099", returnedMargin: "104999999", pairedPayoutAdjustment: "0", payoutCapped: false, accountingComplete: true };
    value.positions[0]!.closes.push({ phase: "confirmed", closeCommitment: "0xa", witness: {}, output: {} as any,
      createdAt: START - 3 * MINUTE_MS, submittedAt: START - 2 * MINUTE_MS, confirmedAt: START,
      markPrice: "23000000", fundingIndex: "0", fundingPayment: "100", realizedPnl: "5000000", returnedMargin: "104999999" });
    h.services.chainTime = async (hash) => hash === closeHash ? START : START - 10 * MINUTE_MS;
    await h.runner().tick();
    const closed = h.state.outbox.find((entry) => entry.data.kind === "closed")!.data;
    expect(closed.submittedAt).toBe(new Date(START - 2 * MINUTE_MS).toISOString());
    expect(closed.timings).toEqual({ closeSubmissionToSettlementMs: 2 * MINUTE_MS });
    expect(closed.proofStartedAt).toBeUndefined();
    expect(closed.pnl).toBe("0.4999999 USDC");
    expect(closed.exitPrice).toBe("$0.23");
    expect(closed.holdingDurationMs).toBe(10 * MINUTE_MS);
  });
});

describe("persisted execution email outbox", () => {
  test("freezes data, recipients, timestamp and key before sending and deduplicates the transition", async () => {
    const h = harness(); const runner = h.runner();
    const data = { kind: "opened" as const, message: "Confirmed original event" };
    await runner.enqueueEmail("cycle-1/opened", data);
    data.message = "later mutation";
    h.now(START + MINUTE_MS);
    await runner.enqueueEmail("cycle-1/opened", { kind: "opened", message: "duplicate event" });
    expect(h.state.outbox).toHaveLength(1);
    h.send(async (entry) => {
      expect(h.checkpoints.at(-1)!.outbox[0]!.firstAttemptAt).toBe(START + MINUTE_MS);
      expect(entry.data.message).toBe("Confirmed original event");
      expect(entry.data.timestamp).toBe(new Date(START).toISOString());
      return { id: "accepted-email-id" };
    });
    await runner.flushOutbox();
    expect(h.state.outbox[0]!.providerId).toBe("accepted-email-id");
    expect(h.checkpoints.at(-1)!.outbox[0]!.state).toBe("accepted");
    await h.runner().flushOutbox();
    expect(h.state.outbox[0]!.attempts).toBe(1);
  });

  test("uncertain acceptance retries the identical payload within 24 hours and holds afterward", async () => {
    const h = harness(); const runner = h.runner(); const attempted: OutboxEntry[] = [];
    await runner.enqueueEmail("cycle-1/closed", { kind: "closed", pnl: "1.25 USDC" });
    h.send(async (entry) => { attempted.push(structuredClone(entry)); throw new Error("unknown provider acceptance"); });
    await runner.flushOutbox();
    h.now(START + MINUTE_MS); await h.runner().flushOutbox();
    expect(attempted).toHaveLength(2);
    expect(attempted[1]!.key).toBe(attempted[0]!.key);
    expect(attempted[1]!.data).toEqual(attempted[0]!.data);
    expect(attempted[1]!.rendered).toEqual(attempted[0]!.rendered);
    h.now(START + DAY_MS); await h.runner().flushOutbox();
    expect(h.state.outbox[0]!.state).toBe("held");
    expect(attempted).toHaveLength(2);
  });

  test("concurrent flush calls cannot double-send and accepted checkpoint failure propagates", async () => {
    const h = harness(); const runner = h.runner();
    await runner.enqueueEmail("setup", { kind: "setup" });
    let calls = 0; let resolveSend: (value: { id: string }) => void = () => {};
    h.send(async () => { calls += 1; return new Promise((resolve) => { resolveSend = resolve; }); });
    const first = runner.flushOutbox();
    await Promise.resolve(); await Promise.resolve();
    await runner.flushOutbox();
    resolveSend({ id: "accepted-once" }); await first;
    expect(calls).toBe(1);
    const failing = harness(); const other = failing.runner();
    await other.enqueueEmail("setup", { kind: "setup" });
    failing.services.persist = async (state) => { if (state.outbox[0]?.state === "accepted") throw new Error("checkpoint failed"); };
    await expect(other.flushOutbox()).rejects.toThrow("checkpoint failed");
    expect(failing.state.outbox[0]!.state).toBe("accepted");
  });

  test("public status excludes private notes, signed transactions, provider IDs and raw errors", async () => {
    const h = harness(); const { wallet, cycle } = attachActive(h);
    wallet.funding.push({ id: "private-id", hash: HASH, signedXdr: "SIGNED_ENVELOPE_SECRET", preparedAt: START });
    cycle.error = "RAW_API_BODY_SECRET";
    await h.runner().enqueueEmail("event", { kind: "failed", message: "Public safe message" });
    h.state.outbox[0]!.providerId = "PROVIDER_ID_PRIVATE";
    const status = JSON.stringify(publicStatus(h.state));
    for (const secret of ["SIGNED_ENVELOPE_SECRET", "RAW_API_BODY_SECRET", "PROVIDER_ID_PRIVATE"]) expect(status).not.toContain(secret);
  });
});
