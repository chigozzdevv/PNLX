import { describe, expect, test } from "bun:test";
import { hashFields } from "@pnlx/crypto";
import type { BatchSettlement, Hex, PrivateMatchIntent } from "@pnlx/protocol-types";
import { RelayerService } from "@/workers/relayer/relayer.service";
import { OracleService } from "@/workers/oracle/oracle.service";
import { MarketsService } from "@/features/markets/markets.service";
import { assertPositionMutationReady } from "@/shared/protocol/position-mutation";
import { ProtocolStore } from "@/shared/state/store";
import { BatchExecutorService } from "@/workers/batch-executor/batch-executor.service";
import { capacityBoundedIntentCommitments } from "@/workers/batch-executor/batch-capacity";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { assertBatchSettlementCapacity } from "@/shared/protocol/batch-settlement-proof";
import { RemoteMatcherClient } from "@/workers/matcher/remote/matcher.service";
import type { CreateExternalSettlementInput } from "@/workers/matcher/matcher.model";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const key = (name: string): Hex => hashFields("worker-resilience", [name]);

function fixture(marketIds = ["test-market"]) {
  const store = new ProtocolStore();
  let commits = 0;
  for (const marketId of marketIds) store.markets.set(marketId, {
    marketId, fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n,
  });
  const executor = {
    store,
    commitExternalBatchSettlement(transcript: ExternalBatchSettlementTranscript) {
      commits += 1;
      const settlement = transcript.settlement;
      store.settlements.set(`${settlement.marketId}:${settlement.batchId}`, settlement);
      for (const update of settlement.orderUpdates) {
        const order = store.orderLifecycle.get(update.intentCommitment)!;
        store.orderLifecycle.set(update.intentCommitment, { ...order, ...update });
      }
      return settlement;
    },
  };
  const add = (marketId: string, label: string, signedSize: bigint) => {
    const intentCommitment = key(label);
    const sequence = BigInt(store.intents.size);
    const payload: PrivateMatchIntent = {
      batchId: `client-${label}`, marketId, intentCommitment,
      ownerCommitment: key(`owner-${label}`), ownerDigest: key(`owner-field-${label}`),
      positionSeed: key(`private-seed-${label}`), noteNullifier: key(`note-${label}`),
      noteChangeCommitment: "0x0", limitPrice: 100_000_000n,
      margin: (signedSize < 0n ? -signedSize : signedSize) * 100n,
      signedSize,
    };
    store.privateMatchIntents.set(intentCommitment, payload);
    store.intents.set(intentCommitment, { ...payload, submissionSequence: sequence } as never);
    store.orderLifecycle.set(intentCommitment, {
      batchId: payload.batchId, marketId, intentCommitment,
      ownerCommitment: payload.ownerCommitment, createdAt: Number(sequence),
      status: "open", updatedAt: Number(sequence),
    });
    return payload;
  };
  const transcript = (input: CreateExternalSettlementInput): ExternalBatchSettlementTranscript => {
    const intents = input.intentCommitments!.map((id) => store.privateMatchIntents.get(id)!);
    const match = new BatchMatcherService().match({
      batchId: input.batchId, market: store.markets.get(input.marketId)!, intents,
    });
    return {
      accountEvents: [], positionOpenings: [],
      settlement: {
        batchId: input.batchId, marketId: input.marketId,
        settlementDigest: key(`settlement-${input.batchId}`),
        orderUpdates: match.orderUpdates, aggregateVolume: match.aggregateVolume,
        fillCount: match.fills.length, proof: {},
      },
    } as unknown as ExternalBatchSettlementTranscript;
  };
  return { add, executor, store, transcript, commits: () => commits };
}

describe("bounded remote matcher", () => {
  test("aborts a stalled creation request without submitting it twice", async () => {
    const original = globalThis.fetch;
    let requests = 0;
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests += 1;
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    }) as unknown as typeof fetch;
    try {
      const client = new RemoteMatcherClient({ url: "https://matcher.test", requestTimeoutMs: 10 });
      await expect(client.createSettlementTranscript({ batchId: "one", marketId: "test" }))
        .rejects.toThrow("request deadline exceeded");
      expect(requests).toBe(1);
      expect(signal?.aborted).toBe(true);
    } finally { globalThis.fetch = original; }
  });

  test("the request deadline covers a stalled response body", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch;
    try {
      const client = new RemoteMatcherClient({ url: "https://matcher.test", requestTimeoutMs: 10 });
      await expect(client.createSettlementTranscript({ batchId: "body", marketId: "test" }))
        .rejects.toThrow("request deadline exceeded");
    } finally { globalThis.fetch = original; }
  });

  test("queued work cannot poll forever", async () => {
    const original = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") posts += 1;
      return Response.json({ jobId: "pending", status: "proving" });
    }) as unknown as typeof fetch;
    try {
      const client = new RemoteMatcherClient({ url: "https://matcher.test", jobTimeoutMs: 20, pollIntervalMs: 2 });
      await expect(client.createSettlementTranscript({ batchId: "queued", marketId: "test" }))
        .rejects.toThrow("job deadline exceeded");
      expect(posts).toBe(1);
    } finally { globalThis.fetch = original; }
  });

  test("retries only bounded transient status reads", async () => {
    const original = globalThis.fetch;
    let gets = 0;
    let posts = 0;
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        return Response.json({ jobId: "retry", status: "queued" });
      }
      gets += 1;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    try {
      const client = new RemoteMatcherClient({ url: "https://matcher.test", pollIntervalMs: 1, readRetries: 2 });
      await expect(client.createSettlementTranscript({ batchId: "reads", marketId: "test" }))
        .rejects.toThrow("status 503");
      expect(posts).toBe(1);
      expect(gets).toBe(3);
    } finally { globalThis.fetch = original; }
  });

  test("rejects an unknown completed-state claim", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ jobId: "bad", status: "maybe", transcript: {} })) as unknown as typeof fetch;
    try {
      await expect(new RemoteMatcherClient({ url: "https://matcher.test" })
        .createSettlementTranscript({ batchId: "invalid", marketId: "test" }))
        .rejects.toThrow("invalid job status");
    } finally { globalThis.fetch = original; }
  });
});

describe("batch progress and recovery", () => {
  test("a stalled market does not stop another market or duplicate its own run", async () => {
    const f = fixture(["stalled", "healthy"]);
    for (const id of ["stalled", "healthy"]) {
      f.add(id, `${id}-long`, 1n);
      f.add(id, `${id}-short`, -1n);
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = new Map<string, number>();
    const worker = new BatchExecutorService(f.executor as never, {
      async createSettlementTranscript(input) {
        calls.set(input.marketId, (calls.get(input.marketId) ?? 0) + 1);
        if (input.marketId === "stalled") await gate;
        return f.transcript(input);
      },
    }, { intervalMs: 2 });
    try {
      worker.start();
      await wait(25);
      expect(f.commits()).toBe(1);
      f.add("healthy", "healthy-second-long", 1n);
      f.add("healthy", "healthy-second-short", -1n);
      await wait(25);
      expect(f.commits()).toBe(2);
      expect(calls.get("stalled")).toBe(1);
      expect(calls.get("healthy")).toBe(2);
    } finally {
      worker.stop();
      release();
      await wait(5);
    }
  });

  test("two worker instances sharing one store do not prove/settle the same market twice", async () => {
    const f = fixture();
    f.add("test-market", "exclusive-long", 1n);
    f.add("test-market", "exclusive-short", -1n);
    let requests = 0;
    const matcher = { async createSettlementTranscript(input: CreateExternalSettlementInput) {
      requests += 1;
      await wait(5);
      return f.transcript(input);
    } };
    const a = new BatchExecutorService(f.executor as never, matcher);
    const b = new BatchExecutorService(f.executor as never, matcher);
    await Promise.all([a.runOnce(), b.runOnce()]);
    expect(requests).toBe(1);
    expect(f.commits()).toBe(1);
  });

  test("packs one budget-safe execution per batch and eventually fills all residual orders", () => {
    const f = fixture();
    const original = [4n, 4n, 4n, -3n, -3n, -6n].map((size, index) =>
      f.add("test-market", `packed-${index}`, size));
    let batches = 0;
    while ([...f.store.orderLifecycle.values()].some((order) => order.status === "open")) {
      const ids = capacityBoundedIntentCommitments(f.store, "test-market", `packed-${batches}`);
      const match = new BatchMatcherService().match({
        batchId: `packed-${batches}`, market: f.store.markets.get("test-market")!,
        intents: ids.map((id) => f.store.privateMatchIntents.get(id)!),
      });
      assertBatchSettlementCapacity({ ...match, newCommitments: match.fills.map((fill) => fill.positionCommitment) });
      expect(match.executions.length).toBe(1);
      for (const update of match.orderUpdates) {
        const order = f.store.orderLifecycle.get(update.intentCommitment)!;
        f.store.orderLifecycle.set(update.intentCommitment, { ...order, ...update });
      }
      for (const residual of match.residuals) {
        const source = f.store.privateMatchIntents.get(residual.sourceIntentCommitment!)!;
        const payload = { ...source, ...residual };
        f.store.privateMatchIntents.set(payload.intentCommitment, payload);
        f.store.residualOrders.set(payload.intentCommitment, {
          ...payload, sourceIntentCommitment: source.intentCommitment,
          submissionSequence: f.store.intents.get(source.intentCommitment)?.submissionSequence,
          createdAt: 0, updatedAt: 0,
        } as never);
        f.store.orderLifecycle.set(payload.intentCommitment, {
          batchId: payload.batchId, marketId: payload.marketId,
          intentCommitment: payload.intentCommitment, ownerCommitment: payload.ownerCommitment,
          createdAt: 0, updatedAt: 0, status: "open",
        });
      }
      batches += 1;
      if (batches > 10) throw new Error("orders did not progress");
    }
    expect(batches).toBe(5);
    expect(original.every((intent) => f.store.orderLifecycle.get(intent.intentCommitment)?.status !== "open")).toBe(true);
  });

  test("a timed-out oracle releases the queue but retains its own writer lock", async () => {
    const f = fixture(["hung", "healthy"]);
    const calls: string[] = [];
    let aborted = false;
    const worker = new BatchExecutorService(f.executor as never, { createSettlementTranscript() { throw new Error("unused"); } }, {
      intervalMs: 1000, oracleRefreshIntervalMs: 5, oracleRefreshTimeoutMs: 10,
      refreshMarketOracle(marketId, signal) {
        calls.push(marketId);
        if (marketId === "hung") {
          signal!.addEventListener("abort", () => { aborted = true; });
          return new Promise(() => {});
        }
      },
    });
    try {
      worker.start();
      await wait(35);
      expect(aborted).toBe(true);
      expect(calls.filter((id) => id === "hung")).toHaveLength(1);
      expect(calls.filter((id) => id === "healthy").length).toBeGreaterThanOrEqual(2);
    } finally { worker.stop(); }
  });

  test("restart resumes the exact proving selection even after new orders arrive", async () => {
    const f = fixture();
    const a = f.add("test-market", "resume-long", 1n);
    const b = f.add("test-market", "resume-short", -1n);
    const ids = [a.intentCommitment, b.intentCommitment];
    f.store.batchExecutionRuns.set(key("old-run"), {
      batchId: "old-batch", marketId: "test-market", runId: key("old-run"), startedAt: 1,
      phase: "proving", status: "running", intentCommitments: ids,
    });
    f.add("test-market", "new-long", 1n);
    let seen: CreateExternalSettlementInput | undefined;
    const worker = new BatchExecutorService(f.executor as never, { createSettlementTranscript(input) {
      seen = input;
      return f.transcript(input);
    } });
    const result = await worker.runOnce();
    expect(seen?.batchId).toBe("old-batch");
    expect(seen?.intentCommitments).toEqual(ids);
    expect(result.results[0]!.record.status).toBe("settled");
    expect("intentCommitments" in result.results[0]!.record).toBe(false);
    expect(f.store.orderLifecycle.get(key("new-long"))?.status).toBe("open");
  });

  test("reconciles a landed settlement after the submit response is lost", async () => {
    const f = fixture();
    f.add("test-market", "landed-long", 1n);
    f.add("test-market", "landed-short", -1n);
    let landed = false;
    let submits = 0;
    const relay = {
      positionRoot: () => f.store.positionMembershipRoot(),
      batchPositionAppendIndexAsync: async () => f.store.positionCommitments.size,
      isBatchSettled: () => landed,
      settleBatch() { submits += 1; landed = true; throw new Error("response lost"); },
    };
    const matcher = { createSettlementTranscript: f.transcript };
    const first = new BatchExecutorService(f.executor as never, matcher, { intervalMs: 1000, settlementsOnchainRequired: true }, relay as never);
    expect((await first.runOnce()).results[0]!.record.status).toBe("failed");
    expect(f.commits()).toBe(0);
    const restored = new BatchExecutorService(f.executor as never, matcher, { intervalMs: 1000, settlementsOnchainRequired: true }, relay as never);
    expect((await restored.runOnce()).results[0]!.record.status).toBe("settled");
    expect(submits).toBe(1);
    expect(f.commits()).toBe(1);
  });

  test("does not resubmit when settlement status cannot be read", async () => {
    const f = fixture();
    f.add("test-market", "unknown-long", 1n);
    f.add("test-market", "unknown-short", -1n);
    let submits = 0;
    const worker = new BatchExecutorService(f.executor as never, { createSettlementTranscript: f.transcript }, {
      intervalMs: 1000, settlementsOnchainRequired: true,
    }, {
      positionRoot: () => f.store.positionMembershipRoot(),
      batchPositionAppendIndexAsync: async () => f.store.positionCommitments.size,
      isBatchSettled() { throw new Error("RPC unavailable"); },
      settleBatch() { submits += 1; },
    } as never);
    const result = await worker.runOnce();
    expect(result.results[0]!.record.status).toBe("failed");
    expect(result.results[0]!.record.reason).toContain("reconciliation required");
    expect(submits).toBe(0);
  });

  test("retries maker finalization after restart without recommitting or reproving", async () => {
    const f = fixture();
    f.add("test-market", "finalize-long", 1n);
    f.add("test-market", "finalize-short", -1n);
    let proofs = 0;
    let finalizations = 0;
    const maker = {
      ensureForMarket() {},
      finalizeSettlement() { finalizations += 1; if (finalizations === 1) throw new Error("disk unavailable"); },
    };
    const matcher = { createSettlementTranscript(input: CreateExternalSettlementInput) { proofs += 1; return f.transcript(input); } };
    const first = new BatchExecutorService(f.executor as never, matcher, { intervalMs: 1000 }, undefined, maker as never);
    expect((await first.runOnce()).results[0]!.record.status).toBe("failed");
    const restored = new BatchExecutorService(f.executor as never, matcher, { intervalMs: 1000 }, undefined, maker as never);
    expect((await restored.runOnce()).results[0]!.record.status).toBe("settled");
    expect(f.commits()).toBe(1);
    expect(proofs).toBe(1);
    expect(finalizations).toBe(2);
  });
});

describe("serialized and cancellation-aware relays", () => {
  const config = (source: string) => ({ mode: "stellar-cli" as const, network: "worker-testnet", source });
  const request = (round = "42") => ({
    kind: "oracle-price" as const,
    payload: { contractId: "oracle-contract", functionName: "submit_other_price", args: ["--round", round] },
  });
  const success = { status: 0, stdout: "a".repeat(64), stderr: "" };

  test("serializes a source across instances while another source progresses", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const a = new RelayerService(config("shared"), undefined, async () => {
      calls.push("first"); await gate; return success;
    });
    const b = new RelayerService(config("shared"), undefined, async () => {
      calls.push("second"); return success;
    });
    const other = new RelayerService(config("independent"), undefined, async () => {
      calls.push("other"); return success;
    });
    const first = a.relayAsync(request());
    const second = b.relayAsync(request());
    try {
      await other.relayAsync(request());
      expect(calls).toEqual(["first", "other"]);
      expect(() => b.relay(request())).toThrow("pending submission");
    } finally { release(); }
    await Promise.all([first, second]);
    expect(calls).toEqual(["first", "other", "second"]);
  });

  test("a cancelled queued send never invokes the CLI", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const relayer = new RelayerService(config("cancelled-queue"), undefined, async () => {
      calls += 1;
      if (calls === 1) await gate;
      return success;
    });
    const first = relayer.relayAsync(request());
    const controller = new AbortController();
    const cancelled = relayer.relayAsync({ ...request(), signal: controller.signal });
    const rejected = cancelled.catch((error: Error) => error);
    controller.abort();
    release();
    await first;
    expect((await rejected as Error).message).toContain("aborted before submission");
    expect(calls).toBe(1);
  });

  test("does not rebuild or retry an uncertain mutation or change its oracle round", async () => {
    const commands: string[][] = [];
    const relayer = new RelayerService(config("uncertain"), undefined, async (command, args) => {
      commands.push([command, ...args]);
      return { status: null, stdout: "", stderr: "request timeout after submission" };
    });
    await expect(relayer.relayAsync(request("12345"))).rejects.toThrow("timeout");
    expect(commands).toHaveLength(1);
    expect(commands[0]![commands[0]!.indexOf("--round") + 1]).toBe("12345");
    expect(relayer.list()).toHaveLength(0);
  });

  test("never resends signed XDR after an unknown response", () => {
    let sends = 0;
    const relayer = new RelayerService(config("signed-uncertain"), (_command, args) => {
      if (args[1] === "hash") return success;
      sends += 1;
      return { status: null, stdout: "", stderr: "request timeout after submission" };
    });
    expect(() => relayer.submitSignedXdr({ xdr: "test-envelope" })).toThrow("timeout");
    expect(sends).toBe(1);
  });
});

describe("bounded oracle reads and stale writers", () => {
  const oracleConfig = { hermesUrl: "https://oracle.test", priceSource: "hermes" as const,
    maxAgeSeconds: 120, maxConfidenceBps: 100n, requestTimeoutMs: 10 };

  test("bounds a stalled body and aborts the fetch", async () => {
    const original = globalThis.fetch;
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start() {} }));
    }) as unknown as typeof fetch;
    try {
      await expect(new OracleService(oracleConfig).latest(key("feed"))).rejects.toThrow("deadline exceeded");
      expect(signal?.aborted).toBe(true);
    } finally { globalThis.fetch = original; }
  });

  test("rejects a future publish time and zero price with a useful error", async () => {
    const original = globalThis.fetch;
    const feedId = key("invalid-feed");
    let price = "100000000";
    let timestamp = Math.floor(Date.now() / 1000) + 60;
    globalThis.fetch = (async () => Response.json({ parsed: [{ id: feedId.slice(2), price: {
      price, conf: "1", expo: -8, publish_time: timestamp,
    } }] })) as unknown as typeof fetch;
    try {
      const oracle = new OracleService(oracleConfig);
      await expect(oracle.latest(feedId)).rejects.toThrow("from the future");
      price = "0";
      timestamp = Math.floor(Date.now() / 1000);
      await expect(oracle.latest(feedId)).rejects.toThrow("must be positive");
    } finally { globalThis.fetch = original; }
  });

  test("cancellation stops late local market writes", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const market = f.store.markets.get("test-market")!;
    const service = new MarketsService(f.executor as never, { async latestMarket() {
      await gate;
      return { price: 200_000_000n, confidence: 0n, confidenceBps: 0n, feedId: key("feed"), publishTime: 1 };
    } } as never, { protocolAdminAddresses: [], oracleOnchainRequired: false, stellarOnchainRelay: false } as never);
    const controller = new AbortController();
    const refresh = service.refreshFromOracle({ marketId: "test-market", feedId: key("feed") }, undefined, controller.signal);
    const rejected = refresh.catch((error: Error) => error);
    controller.abort();
    release();
    expect((await rejected as Error).message).toContain("aborted before mutation");
    expect(f.store.markets.get("test-market")).toEqual(market);
  });

  test("a slow price read preserves concurrent funding and risk updates", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new MarketsService(f.executor as never, { async latestMarket() {
      await gate;
      return { price: 200_000_000n, confidence: 0n, confidenceBps: 0n, feedId: key("feed"), publishTime: 1 };
    } } as never, { protocolAdminAddresses: [], oracleOnchainRequired: false, stellarOnchainRelay: false } as never);
    const refresh = service.refreshFromOracle({ marketId: "test-market", feedId: key("feed") });
    f.store.markets.set("test-market", { ...f.store.markets.get("test-market")!, fundingIndex: 77n, maxLeverage: 9n });
    release();
    const result = await refresh;
    expect(result.market.fundingIndex).toBe(77n);
    expect(result.market.maxLeverage).toBe(9n);
    expect(result.market.oraclePrice).toBe(200_000_000n);
  });
});

describe("journaled transaction authority", () => {
  const xdrs = { built: "Q".repeat(32), assembled: "R".repeat(32), signed: "S".repeat(32) };
  const txHash = `0x${"a".repeat(64)}` as Hex;
  const request = { kind: "position-close" as const,
    payload: { contractId: "close-contract", functionName: "close_pair", args: ["--proof", "bound-proof"] } };
  const config = (source: string, commandTimeoutMs = 100) => ({
    mode: "stellar-cli" as const, network: "journal-testnet", source, rpcUrl: "https://rpc.test", commandTimeoutMs,
  });
  const output = (stdout: string) => ({ status: 0, stderr: "", stdout });
  const route = (args: string[]) => {
    if (args.includes("--build-only")) return output(xdrs.built);
    if (args[1] === "simulate") return output(xdrs.assembled);
    if (args[1] === "sign") return output(xdrs.signed);
    return output(txHash);
  };

  test("persists the exact signed transaction before sending and holds source ownership", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const relayer = new RelayerService(config("journal-lock"), undefined, async (_command, args) => {
      if (args[1] === "send") { events.push("send"); expect(args[2]).toBe(xdrs.signed); }
      else if (!args.includes("--build-only") && args[0] === "contract") events.push("next");
      return route(args);
    });
    let prepared: { txHash: Hex; xdr: string } | undefined;
    const pending = relayer.relayJournaled(request, async (value) => {
      prepared = value; events.push("persist"); await gate;
    });
    await wait(5);
    const next = relayer.relayAsync(request);
    expect(prepared).toEqual({ txHash, xdr: xdrs.signed });
    expect(events).toEqual(["persist"]);
    release();
    const result = await pending;
    await next;
    expect(events).toEqual(["persist", "send", "next"]);
    expect(result.functionName).toBe("close_pair");
    expect(result.contractId).toBe("close-contract");
    expect(result.command).toContain("<signed-xdr-redacted>");
  });

  test("failed persistence prevents submission", async () => {
    let sends = 0;
    const relayer = new RelayerService(config("journal-durable"), undefined, async (_command, args) => {
      if (args[1] === "send") sends += 1;
      return route(args);
    });
    await expect(relayer.relayJournaled(request, async () => { throw new Error("journal unavailable"); }))
      .rejects.toThrow("journal unavailable");
    expect(sends).toBe(0);
  });

  test("a lost send response retains its preknown hash and never rebuilds on resume", async () => {
    let lost = true;
    let persisted: { txHash: Hex; xdr: string } | undefined;
    const commands: string[][] = [];
    const relayer = new RelayerService(config("journal-resume"), undefined, async (_command, args) => {
      commands.push(args);
      if (args[1] === "send" && lost) return { status: null, stdout: "", stderr: "timeout" };
      return route(args);
    });
    let error: unknown;
    try { await relayer.relayJournaled(request, async (value) => { persisted = value; }); }
    catch (cause) { error = cause; }
    expect((error as { txHash: Hex }).txHash).toBe(txHash);
    expect(persisted?.xdr).toBe(xdrs.signed);
    lost = false;
    commands.length = 0;
    const result = await relayer.relayJournaled(request, async () => {}, persisted!);
    expect(result.txHash).toBe(txHash);
    expect(commands.map((args) => args[1])).toEqual(["hash", "send"]);
    expect(commands[1]![2]).toBe(xdrs.signed);
  });

  test("rejects a resume envelope that does not hash to the persisted transaction", async () => {
    let sends = 0;
    const relayer = new RelayerService(config("journal-tamper"), undefined, async (_command, args) => {
      if (args[1] === "send") sends += 1;
      return route(args);
    });
    await expect(relayer.relayJournaled(request, async () => {}, { txHash: key("different"), xdr: xdrs.signed }))
      .rejects.toThrow("does not match");
    expect(sends).toBe(0);
  });

  test("RPC reconciliation accepts only explicit terminal/not-found statuses and is bounded", async () => {
    const original = globalThis.fetch;
    let status = "SUCCESS";
    globalThis.fetch = (async () => Response.json({ result: { status } })) as unknown as typeof fetch;
    const relayer = new RelayerService(config("journal-status", 10));
    try {
      expect(await relayer.readTransactionStatus(txHash)).toBe("SUCCESS");
      status = "FAILED";
      expect(await relayer.readTransactionStatus(txHash)).toBe("FAILED");
      status = "NOT_FOUND";
      expect(await relayer.readTransactionStatus(txHash)).toBe("NOT_FOUND");
      status = "maybe";
      await expect(relayer.readTransactionStatus(txHash)).rejects.toThrow("invalid status");
      globalThis.fetch = (async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch;
      await expect(relayer.readTransactionStatus(txHash)).rejects.toThrow("deadline exceeded");
    } finally { globalThis.fetch = original; }
  });
});

test("parallel market proofs preserve chain/local append order through a stalled confirmation", async () => {
  const f = fixture(["a", "b"]);
  for (const market of ["a", "b"]) { f.add(market, `${market}-l`, 1n); f.add(market, `${market}-s`, -1n); }
  let releaseProofs!: () => void;
  let releaseConfirmation!: () => void;
  const proofGate = new Promise<void>((resolve) => { releaseProofs = resolve; });
  const confirmationGate = new Promise<void>((resolve) => { releaseConfirmation = resolve; });
  let proofs = 0;
  const events: string[] = [];
  const landed = new Set<string>();
  const commit = f.executor.commitExternalBatchSettlement.bind(f.executor);
  f.executor.commitExternalBatchSettlement = (transcript) => {
    events.push(`commit:${transcript.settlement.marketId}`); return commit(transcript);
  };
  const worker = new BatchExecutorService(f.executor as never, { async createSettlementTranscript(input) {
    proofs += 1; await proofGate; return f.transcript(input);
  } }, { intervalMs: 1000, settlementsOnchainRequired: true }, {
    positionRoot: () => f.store.positionMembershipRoot(),
    batchPositionAppendIndexAsync: async () => f.store.positionCommitments.size,
    async isBatchSettledAsync(_batchId: string, marketId: string) {
      if (marketId === "a" && landed.has("a")) await confirmationGate;
      return landed.has(marketId);
    },
    settleBatch(settlement: BatchSettlement) {
      events.push(`chain:${settlement.marketId}`); landed.add(settlement.marketId);
      return { relays: [{ functionName: "verify_and_record", submitted: true, txHash: key("proof") }] };
    },
  } as never);
  const work = worker.runOnce();
  try {
    await wait(5);
    expect(proofs).toBe(2);
    releaseProofs();
    await wait(5);
    expect(events).toEqual(["chain:a"]);
  } finally { releaseProofs(); releaseConfirmation(); }
  await work;
  expect(events).toEqual(["chain:a", "commit:a", "chain:b", "commit:b"]);
});

describe("uncertain financial mutation gate", () => {
  test("unresolved attempts block other writers but allow their own recovery", () => {
    const f = fixture();
    const runId = key("uncertain-gate-run");
    const run = { runId, marketId: "test-market", batchId: "uncertain-batch", startedAt: 1,
      status: "failed" as const, submissionAttempted: true, settlementDigest: key("uncertain-digest") };
    f.store.batchExecutionRuns.set(runId, run);
    expect(() => assertPositionMutationReady(f.store, "batch", runId)).not.toThrow();
    expect(() => assertPositionMutationReady(f.store, "pair", key("other-pair"))).toThrow("pending batch");
    f.store.settlements.set("committed", { batchId: run.batchId, marketId: run.marketId,
      settlementDigest: run.settlementDigest } as BatchSettlement);
    expect(() => assertPositionMutationReady(f.store, "pair", key("other-pair"))).not.toThrow();
  });

  test("unattempted work does not block, while a known pending pair does", () => {
    const f = fixture();
    f.store.batchExecutionRuns.set(key("only-proving"), { runId: key("only-proving"), marketId: "test-market",
      batchId: "not-attempted", startedAt: 1, phase: "proving", status: "running" });
    const pairId = key("pending-pair");
    const closeIds = [key("pending-close-a"), key("pending-close-b")];
    const pending = { journalKey: pairId, pair: { positions: closeIds.map((closeCommitment) => ({ closeCommitment })) } };
    f.store.pendingPairedCloses.set(pairId, pending as never);
    expect(() => assertPositionMutationReady(f.store, "batch", key("other"))).not.toThrow();
    f.store.pendingPairedCloses.set(pairId, { ...pending, settlementTxHash: key("pending-tx") } as never);
    expect(() => assertPositionMutationReady(f.store, "batch", key("other"))).toThrow("pending pair");
    expect(() => assertPositionMutationReady(f.store, "pair", pairId)).not.toThrow();
    f.store.pendingPairedCloses.set(pairId, { ...pending, settlementTxHash: key("pending-tx"), retired: true } as never);
    expect(() => assertPositionMutationReady(f.store, "batch", key("other"))).not.toThrow();
    f.store.pendingPairedCloses.set(pairId, { ...pending, settlementTxHash: key("pending-tx") } as never);
    for (const close of closeIds) f.store.positionCloses.set(close, {} as never);
    expect(() => assertPositionMutationReady(f.store, "batch", key("other"))).not.toThrow();
  });

  test("a lost batch response gates other appends until exact-batch recovery commits locally", async () => {
    const f = fixture(["a", "b"]);
    for (const market of ["a", "b"]) { f.add(market, `${market}-g-l`, 1n); f.add(market, `${market}-g-s`, -1n); }
    let pendingA = true;
    let landedA = false;
    let savedAttempt = false;
    Object.assign(f.store, { async flush() {
      savedAttempt ||= [...f.store.batchExecutionRuns.values()].some((run) => run.marketId === "a" && run.submissionAttempted);
    } });
    const events: string[] = [];
    const relay = {
      positionRoot: () => f.store.positionMembershipRoot(),
      batchPositionAppendIndexAsync: async () => f.store.positionCommitments.size,
      isBatchSettled(_batch: string, market: string) { return market === "a" ? landedA : events.includes("chain:b"); },
      settleBatch(settlement: BatchSettlement) {
        expect(savedAttempt).toBe(true);
        if (settlement.marketId === "a" && pendingA) { events.push("attempt:a"); throw new Error("response lost"); }
        events.push(`chain:${settlement.marketId}`);
        return { relays: [{ functionName: "verify_and_record", submitted: true, txHash: key("proof") }] };
      },
    };
    const matcher = { createSettlementTranscript: f.transcript };
    const config = { intervalMs: 1000, settlementsOnchainRequired: true };
    const first = await new BatchExecutorService(f.executor as never, matcher, config, relay as never).runOnce();
    expect(first.results.every((result) => result.record.status === "failed")).toBe(true);
    expect(events).toEqual(["attempt:a"]);
    expect(f.commits()).toBe(0);
    pendingA = false;
    landedA = true;
    const recovered = await new BatchExecutorService(f.executor as never, matcher, config, relay as never).runOnce();
    expect(recovered.results.every((result) => result.record.status === "settled")).toBe(true);
    expect(events).toEqual(["attempt:a", "chain:b"]);
    expect(f.commits()).toBe(2);
  });
});

test("an external pair append cannot reorder the local batch tree, and confirmed recovery follows its authoritative index", async () => {
  const f = fixture();
  f.add("test-market", "index-race-long", 1n);
  f.add("test-market", "index-race-short", -1n);
  let landed = false;
  let sends = 0;
  const relay = {
    positionRoot: () => f.store.positionMembershipRoot(),
    isBatchSettled: () => landed,
    batchPositionAppendIndexAsync: async () => 1,
    settleBatch() {
      sends += 1;
      // A permissionless pair proof appends at index zero between preflight and settlement.
      landed = true;
      return { relays: [{ functionName: "verify_and_record", submitted: true, txHash: key("index-proof") }] };
    },
  };
  const config = { intervalMs: 1000, settlementsOnchainRequired: true };
  const matcher = { createSettlementTranscript: f.transcript };
  const first = await new BatchExecutorService(f.executor as never, matcher, config, relay as never).runOnce();
  expect(first.results[0]!.record.reason).toContain("append index is out of order");
  expect(f.commits()).toBe(0);
  f.store.positionCommitments.add(key("authoritatively-recovered-prior-pair-output"));
  const futurePairId = key("other-pending-later-pair");
  f.store.pendingPairedCloses.set(futurePairId, { journalKey: futurePairId, settlementTxHash: key("other-known-tx"),
    pair: { positions: [{ closeCommitment: key("future-a") }, { closeCommitment: key("future-b") }] } } as never);
  const recovered = await new BatchExecutorService(f.executor as never, matcher, config, relay as never).runOnce();
  expect(recovered.results[0]!.record.status).toBe("settled");
  expect(sends).toBe(1);
  expect(f.commits()).toBe(1);
});
