import { describe, expect, test } from "bun:test";
import { commitIntent, fieldHex, ownerCommitment, positionSecrets } from "@pnlx/crypto";
import { createCircuitPositionNote, createSecureMarginNote } from "@pnlx/sdk";
import type { Hex, TradeIntent } from "@pnlx/protocol-types";
import { createPositionOpeningAccountEvent, createPositionCloseAccountEvent } from "../../server/src/shared/protocol/account-event-outcomes";
import { ObservationProtocol, observationOrderSize, OBSERVATION_USDC, OBSERVATION_ISSUER, activeObservationOrders, confirmedCloseAccounting,
  type ProtocolState, type ProtocolIdentity, type OpenSpec } from "./protocol";

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OWNER = ownerCommitment(ADDRESS);
const ASSET: Hex = fieldHex(456n);
const TX: Hex = `0x${"12".repeat(32)}`;
const CLOSE_TX: Hex = `0x${"34".repeat(32)}`;
const ROOT: Hex = fieldHex(789n);
const SPEC: OpenSpec = { id: "cycle-001", marketId: "xlm-usd-perp", side: "long", margin: "100000000", leverage: 3 };
const identity: ProtocolIdentity = { source: "observation-trader", address: ADDRESS,
  signMessage: async () => "signed-message", signTransaction: async () => "c2lnbmVk" };

function fixture(options: { loseIntent?: boolean; loseClose?: boolean; loseCancel?: boolean; loseRefund?: boolean;
  failPersistAt?: string; healthNetwork?: string; challengeNetwork?: string } = {}) {
  let saved: ProtocolState | undefined;
  let registeredKey: any = null;
  let portfolio: any = { ownerCommitment: OWNER, orders: [], positions: [], accountEvents: [] };
  let intentPosts = 0, closePosts = 0, relayPosts = 0, cancelPosts = 0, refundPosts = 0;
  const claimed = new Map<string, Hex>();
  let lastClose: any;
  const calls: Array<{ path: string; body: any }> = [];
  let loseIntent = options.loseIntent ?? false;
  let loseClose = options.loseClose ?? false;
  let closeStatus: Record<string, unknown> = { canRetry: false, transactionStatus: "NOT_FOUND" };
  let depositStatus: Record<string, unknown> = { canRetry: false, transactionStatus: "NOT_FOUND" };
  const fetcher: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const respond = (value: unknown, status = 200) => Response.json(value, { status });
    if (path === "/auth/challenge") return respond({ address: ADDRESS, ownerCommitment: OWNER, expiresAt: Date.now() + 60_000,
      signingMode: "stellar-ed25519-message", message: "challenge", nonce: "nonce", networkPassphrase: options.challengeNetwork ?? "Test SDF Network ; September 2015" });
    if (path === "/auth/session") return respond({ address: ADDRESS, ownerCommitment: OWNER, expiresAt: Date.now() + 86_400_000,
      token: "test-token", networkPassphrase: "Test SDF Network ; September 2015" });
    if (path === "/health") return respond({ ok: true, auth: { required: true },
      custody: { required: true, readyForRealAssets: true, collateralAsset: { tokenContract: OBSERVATION_USDC, tokenDigest: ASSET, code: "USDC", issuer: OBSERVATION_ISSUER } },
      intentRegistry: { onchainRequired: true }, settlements: { onchainRequired: true },
      stellar: { network: options.healthNetwork ?? "testnet", onchainRelayEnabled: true, networkPassphrase: "Test SDF Network ; September 2015" },
      runtime: { clientStorageScope: "test-scope" }, privacy: { hostedPairedCloseWitnessRoutesEnabled: true },
      batchExecutor: { enabled: true }, matching: { readyForPrivateMatching: true, proofEngine: { devMode: false } } });
    if (path === "/account-keys") {
      if (body) registeredKey = body;
      return respond({ accountKey: registeredKey });
    }
    if (path === "/markets") return respond({ markets: [{ marketId: SPEC.marketId, maxLeverage: "10", initialMarginRate: "100000", oraclePrice: "20000000", fundingIndex: "4" }] });
    if (path === "/notes/membership") {
      const commitment = parsed.searchParams.get("commitment");
      return respond({ note: { commitment, membershipRoot: ROOT, membershipProof: { leaf: commitment, root: ROOT, indices: [], siblings: [] } } });
    }
    if (path === "/intent-validity") {
      const intent: TradeIntent = { ...body, limitPrice: BigInt(body.limitPrice), margin: BigInt(body.margin), size: BigInt(body.size) };
      return respond({ artifact: { proof: {} }, record: { ...body, proof: {}, intentCommitment: commitIntent(intent), positionSeed: fieldHex(444n) } });
    }
    if (path === "/secure-deposit-note") return respond({ artifact: { proof: {} }, record: { ...body, proof: {} } });
    if (path === "/proofs/artifacts") return respond({ artifact: {} });
    if (path === "/intents") {
      intentPosts++;
      expect(saved?.cycles[SPEC.id]?.phase).toBe("submitting");
      expect(saved?.cycles[SPEC.id]?.intent).toEqual(body.intent);
      if (loseIntent) { loseIntent = false; throw new Error("connection lost after server accepted the intent"); }
      return respond({ intentCommitment: body.validity.intentCommitment, ownerCommitment: OWNER, marketId: body.intent.marketId, submissionTxHash: TX });
    }
    if (path === "/portfolio") return respond({ portfolio });
    if (path === "/orders/cancel") {
      cancelPosts++;
      const cancellation = saved!.cycles[SPEC.id]!.cancellations![body.intentCommitment.toLowerCase()];
      expect(cancellation!.phase).toBe("submitting");
      if (options.loseCancel) throw new Error("cancellation response lost");
      const order = portfolio.orders.find((order: any) => order.intentCommitment === body.intentCommitment);
      order.status = "cancelled"; order.cancellationTxHash = CLOSE_TX;
      return respond({ order });
    }
    if (path === "/orders/residual-claim") return respond({ amount: "50000000", tokenDigest: ASSET, claimedCommitment: claimed.get(body.intentCommitment) });
    if (path === "/orders/claim-residual") {
      refundPosts++;
      const refund = saved!.cycles[SPEC.id]!.refunds![body.intentCommitment.toLowerCase()]!;
      expect(refund.phase).toBe("submitting");
      expect(saved!.notes.some((note) => note.commitment === body.depositProof.commitment)).toBe(true);
      claimed.set(body.intentCommitment, body.depositProof.commitment);
      if (options.loseRefund) throw new Error("refund claim response lost after chain acceptance");
      return respond({ amount: body.depositProof.amount, commitment: body.depositProof.commitment, claimTxHash: CLOSE_TX });
    }
    if (path === "/notes/recovery-status") return respond({ notes: body.notes.map((note: any) => ({ commitment: note.commitment, known: true, spent: false })) });
    if (path === "/position-closes/context") return respond({ context: { payoutAmount: "99990000", market: { marketId: SPEC.marketId, markPrice: "20000000", fundingIndex: "4" },
      positionRoot: ROOT, membershipProof: { leaf: parsed.searchParams.get("positionCommitment"), root: ROOT, indices: [], siblings: [] } } });
    if (path === "/position-closes/status") {
      const attempt = saved!.cycles[SPEC.id]!.positions[0]!.closes.find((entry) => entry.closeCommitment === parsed.searchParams.get("closeCommitment"))!;
      expect(init?.headers).toHaveProperty("authorization", "Bearer test-token");
      return respond({ status: { ownerCommitment: OWNER, positionCommitment: parsed.searchParams.get("positionCommitment"),
        closeCommitment: attempt.closeCommitment, marginOutputCommitment: attempt.output.commitment,
        settlementTxHash: CLOSE_TX, ...closeStatus } });
    }
    if (path === "/position-closes/manual") {
      closePosts++; lastClose = body;
      const attempt = saved?.cycles[SPEC.id]?.positions[0]?.closes.at(-1);
      expect(attempt?.phase).toBe("submitting");
      expect(attempt?.output.commitment).toBe(body.marginOutputCommitment);
      if (loseClose) { loseClose = false; throw new Error("close response lost after server submitted"); }
      return respond({ positionClose: { ...body, proof: { circuitId: "position-close-pair" }, settlementTxHash: CLOSE_TX } });
    }
    if (path === "/notes/deposit-asset/prepare-proven") return respond({
      action: { xdr: "dW5zaWduZWQ=", functionName: "deposit_asset_secure" }, depositProof: body.depositProof,
      pendingDeposit: { ...body, tokenDigest: ASSET, preparedTxHash: TX, preparedXdrDigest: ROOT },
    });
    if (path === "/relays/signed-xdr") {
      relayPosts++; expect(saved?.deposits["deposit-001"]?.signedXdr).toBe("c2lnbmVk");
      expect(saved?.deposits["deposit-001"]?.phase).toBe("submitting");
      throw new Error("relay response lost");
    }
    if (path === "/notes/deposit-asset/recover-confirmed") return respond({ error: "transaction confirmation pending" }, 500);
    if (path === "/notes/deposit-asset/status") {
      expect(init?.headers).toHaveProperty("authorization", "Bearer test-token");
      if (depositStatus.unavailable) throw new Error("status service unavailable");
      const deposit = saved!.deposits["deposit-001"]!;
      return respond({ status: { commitment: parsed.searchParams.get("commitment"), expectedTxHash: parsed.searchParams.get("expectedTxHash"),
        from: ADDRESS, token: OBSERVATION_USDC, tokenDigest: ASSET, amount: deposit.amount, ...depositStatus } });
    }
    throw new Error(`Unexpected test route ${path}`);
  }) as typeof fetch;
  const seed = new ObservationProtocol({ identity, fetch: fetcher, persist: async () => {} }).state;
  seed.collateralDigest = ASSET;
  const note = createSecureMarginNote({ amount: 1_000_000_000n, assetId: "usdc", assetDigest: ASSET,
    owner: ADDRESS, spendSecret: "spend", rho: "rho", blinding: "blinding" });
  seed.notes.push({ ...note, amount: note.amount.toString(), ownerCommitment: OWNER, walletAddress: ADDRESS, status: "available" });
  const persist = async (state: ProtocolState) => {
    if (options.failPersistAt && state.cycles[SPEC.id]?.phase === options.failPersistAt) throw new Error("disk full");
    saved = JSON.parse(JSON.stringify(state));
  };
  const make = (state: ProtocolState = seed) => new ObservationProtocol({ identity, state, fetch: fetcher, persist });
  const adapter = make();
  const addOpening = () => {
    const cycle = saved!.cycles[SPEC.id]!;
    const opening = { entryFee: "10000", entryPrice: "20000000", fundingIndex: "4", margin: "99990000",
      marketId: SPEC.marketId, positionCommitment: "0x0" as Hex, positionNullifier: "0x0" as Hex,
      ownerDigest: seed.notes[0]!.ownerDigest, positionSeed: fieldHex(444n), fillIndex: 0,
      side: SPEC.side, size: cycle.intent.size, sourceIntentCommitment: cycle.intentCommitment };
    const secrets = positionSecrets(opening.positionSeed, opening.fillIndex);
    const position = createCircuitPositionNote({ ...opening, ...secrets, blindingDigest: secrets.blinding,
      entryPrice: BigInt(opening.entryPrice), fundingIndex: BigInt(opening.fundingIndex), margin: BigInt(opening.margin), size: BigInt(opening.size),
      owner: OWNER, ownerDigest: opening.ownerDigest, rho: "", blinding: "", spendSecret: "" });
    opening.positionCommitment = position.commitment; opening.positionNullifier = position.positionNullifier;
    const snapshot: any = { batchId: "settled-batch", marketId: SPEC.marketId, openedAt: Date.now(), updatedAt: Date.now(),
      positionCommitment: position.commitment, sourceIntentCommitment: cycle.intentCommitment, status: "open",
      settlementDigest: ROOT, settlementTxHash: TX };
    portfolio.orders = [{ batchId: cycle.intent.batchId, createdAt: Date.now(), updatedAt: Date.now(),
      intentCommitment: cycle.intentCommitment, marketId: SPEC.marketId, status: "filled", matching: { state: "settled", status: "settled", runId: ROOT } }];
    portfolio.positions.push(snapshot);
    portfolio.accountEvents.push(createPositionOpeningAccountEvent({ ...snapshot, ownerCommitment: OWNER }, opening as any, saved!.accountKey!.publicKey));
    return { opening, snapshot };
  };
  const confirmClose = () => {
    const position = saved!.cycles[SPEC.id]!.positions[0]!;
    const attempt = position.closes.at(-1)!;
    // Production encrypts the close event before the final transaction is known.
    const record = { ...lastClose, proof: { circuitId: "position-close-pair" } };
    const snapshot = portfolio.positions[0];
    Object.assign(snapshot, { status: "closed", closeCommitment: attempt.closeCommitment,
      marginOutputCommitment: attempt.output.commitment, lifecycleTxHash: CLOSE_TX });
    portfolio.accountEvents.push(createPositionCloseAccountEvent(record, { ...snapshot, positionNullifier: position.opening.positionNullifier,
      ownerCommitment: OWNER }, saved!.accountKey!.publicKey, Date.now(), { ...attempt.output }));
  };
  const addUnmatched = () => {
    const cycle = saved!.cycles[SPEC.id]!;
    portfolio.orders = [{ batchId: cycle.intent.batchId, createdAt: Date.now(), updatedAt: Date.now(),
      intentCommitment: cycle.intentCommitment, marketId: cycle.spec.marketId, status: "open", isResidual: false,
      matching: { state: "waiting-liquidity", status: "skipped" } }];
  };
  const addResidual = () => {
    const parent = portfolio.orders[0]; parent.status = "partially-filled";
    portfolio.orders.push({ ...parent, intentCommitment: fieldHex(939n), isResidual: true,
      sourceIntentCommitment: parent.intentCommitment, status: "open" });
  };
  const confirmCancellation = () => { for (const order of activeObservationOrders(portfolio.orders)) {
    order.status = "cancelled"; order.cancellationTxHash = CLOSE_TX;
  } };
  return { adapter, make, calls, addOpening, confirmClose, addUnmatched, addResidual, confirmCancellation, get saved() { return saved!; },
    setCloseStatus(value: Record<string, unknown>) { closeStatus = value; },
    setDepositStatus(value: Record<string, unknown>) { depositStatus = value; },
    get intentPosts() { return intentPosts; }, get closePosts() { return closePosts; }, get relayPosts() { return relayPosts; },
    get cancelPosts() { return cancelPosts; }, get refundPosts() { return refundPosts; } };
}

describe("real observation protocol adapter safety", () => {
  test("rejects remote API, wrong identity, and unsecured proof service before any request", () => {
    expect(() => new ObservationProtocol({ identity, persist: async () => {}, apiUrl: "https://pnlx.example" })).toThrow("deployed VPS API");
    expect(() => new ObservationProtocol({ identity, persist: async () => {}, proverUrl: "http://public-prover.example" })).toThrow("HTTPS");
    const state = fixture().adapter.state; state.source = "maker";
    expect(() => new ObservationProtocol({ identity, state, persist: async () => {} })).toThrow("supplied trader identity");
  });

  test("enforces the approved market/margin/leverage scope and fee-aware size", async () => {
    const f = fixture();
    for (const marketId of ["btc-usd-perp", "eth-usd-perp", "sol-usd-perp"]) {
      await expect(f.adapter.prepareOpen({ ...SPEC, marketId })).rejects.toThrow("only XLM/USD");
    }
    await expect(f.adapter.prepareOpen({ ...SPEC, margin: "10000000000" })).rejects.toThrow("10, 25, 50 or 100");
    await expect(f.adapter.prepareOpen({ ...SPEC, leverage: 10 })).rejects.toThrow("approved sequence");
    const cycle = await f.adapter.prepareOpen(SPEC);
    expect(cycle.phase).toBe("ready");
    expect(BigInt(cycle.intent.size)).toBe(observationOrderSize(100_000_000n, 3, 20_200_000n));
    expect(BigInt(cycle.intent.size) * BigInt(cycle.intent.limitPrice) / 100_000_000n).toBeLessThan(300_000_000n);
    expect(f.calls.some((call) => ["/markets/update", "/markets/oracle", "/batches/settle"].includes(call.path))).toBe(false);
  });

  test("Testnet and Circle asset guards stop before any proof or custody submission", async () => {
    const wrongChallenge = fixture({ challengeNetwork: "Public Global Stellar Network ; September 2015" });
    await expect(wrongChallenge.adapter.authenticate()).rejects.toThrow("identity/network");
    expect(wrongChallenge.calls.some((call) => call.path === "/auth/session")).toBe(false);
    const wrongHealth = fixture({ healthNetwork: "mainnet" });
    await expect(wrongHealth.adapter.prepareDeposit("deposit-001", "100000000")).rejects.toThrow("not ready");
    expect(wrongHealth.calls.some((call) => call.path === "/secure-deposit-note")).toBe(false);
  });

  test("failed durable pre-submit write sends no financial request", async () => {
    const f = fixture({ failPersistAt: "submitting" });
    await f.adapter.prepareOpen(SPEC);
    await expect(f.adapter.open(SPEC.id)).rejects.toThrow("disk full");
    expect(f.intentPosts).toBe(0);
  });

  test("lost intent response locks the input and restart only observes its saved commitment", async () => {
    const f = fixture({ loseIntent: true });
    await f.adapter.prepareOpen(SPEC);
    const uncertain = await f.adapter.open(SPEC.id);
    expect(uncertain.phase).toBe("uncertain");
    expect(f.saved.notes[0]!.status).toBe("locked");
    await f.adapter.open(SPEC.id);
    expect(f.intentPosts).toBe(1);
    const restarted = f.make(f.saved);
    await restarted.open(SPEC.id);
    expect(f.intentPosts).toBe(1);
    f.addOpening();
    const opened = await restarted.pollOpen(SPEC.id);
    expect(opened.phase).toBe("open");
    expect(opened.positions[0]!.opening.entryFee).toBe("10000");
    expect(opened.positions[0]!.snapshot.settlementTxHash).toBe(TX);
    expect(opened.matching[0]!.matching.runId).toBe(ROOT);
  });

  test("paired close output is durable before submission and unknown outcomes reconcile without duplicate closes", async () => {
    const f = fixture({ loseClose: true });
    await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id); f.addOpening(); await f.adapter.pollOpen(SPEC.id);
    const prepared = await f.adapter.prepareClose(SPEC.id);
    expect(prepared.positions[0]!.closes[0]!.markPrice).toBe("20000000");
    await f.adapter.close(SPEC.id);
    expect(f.saved.cycles[SPEC.id]!.positions[0]!.closes[0]!.phase).toBe("uncertain");
    const restarted = f.make(f.saved);
    await restarted.close(SPEC.id);
    expect(f.closePosts).toBe(1);
    f.confirmClose();
    const closed = await restarted.pollClose(SPEC.id);
    expect(closed.phase).toBe("closed");
    expect(closed.positions[0]!.confirmedClose?.settlementTxHash).toBe(CLOSE_TX);
    expect(closed.positions[0]!.confirmedClose?.returnedMargin).toBe("99990000");
    expect(closed.positions[0]!.confirmedClose?.entryFee).toBe("10000");
    expect(closed.positions[0]!.confirmedClose?.closeFee).toBe("0");
    expect(closed.positions[0]!.confirmedClose?.totalFees).toBe("10000");
    expect(closed.positions[0]!.confirmedClose?.netPnl).toBe("-10000");
    expect(closed.positions[0]!.confirmedClose?.grossPricePnl).toBe("0");
    expect(closed.positions[0]!.confirmedClose?.fundingPayment).toBe("0");
    expect(closed.positions[0]!.confirmedClose?.realizedPnl).toBeUndefined();
    expect(f.saved.notes.some((note) => note.amount === "99990000" && note.status === "available")).toBe(true);
  });

  test("confirmed failed close is retained and a fresh close can settle after restart", async () => {
    const f = fixture({ loseClose: true });
    await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id); f.addOpening(); await f.adapter.pollOpen(SPEC.id);
    await f.adapter.prepareClose(SPEC.id); await f.adapter.close(SPEC.id);
    const old = structuredClone(f.saved.cycles[SPEC.id]!.positions[0]!.closes[0]!);
    const failedHash: Hex = `0x${"56".repeat(32)}`;
    f.setCloseStatus({ canRetry: true, transactionStatus: "FAILED", settlementTxHash: failedHash });
    const restarted = f.make(f.saved);
    const reconciled = await restarted.pollClose(SPEC.id);
    const failed = reconciled.positions[0]!.closes[0]!;
    expect(failed.phase).toBe("context-rejected");
    expect(failed.failedTransaction?.txHash).toBe(failedHash);
    expect(failed.output).toEqual(old.output);
    expect(failed.witness).toEqual(old.witness);
    expect(failed.error).toBe(old.error);
    expect(f.closePosts).toBe(1);
    f.setCloseStatus({ canRetry: false, transactionStatus: "NOT_FOUND" });
    const prepared = await restarted.prepareClose(SPEC.id);
    expect(prepared.positions[0]!.closes).toHaveLength(2);
    expect(prepared.positions[0]!.closes[1]!.closeCommitment).not.toBe(old.closeCommitment);
    expect(prepared.positions[0]!.closes[1]!.output.commitment).not.toBe(old.output.commitment);
    await restarted.close(SPEC.id);
    expect(f.closePosts).toBe(2);
    f.confirmClose();
    const closed = await restarted.pollClose(SPEC.id);
    expect(closed.phase).toBe("closed");
    expect(closed.positions[0]!.confirmedClose?.settlementTxHash).toBe(CLOSE_TX);
    expect(closed.positions[0]!.closes[0]!.failedTransaction?.txHash).toBe(failedHash);
  });

  test("unknown or unapproved outcomes remain observation-only", async () => {
    for (const transactionStatus of ["NOT_FOUND", "SUCCESS", "FAILED"]) {
      const f = fixture({ loseClose: true });
      await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id); f.addOpening(); await f.adapter.pollOpen(SPEC.id);
      await f.adapter.prepareClose(SPEC.id); await f.adapter.close(SPEC.id);
      f.setCloseStatus({ canRetry: false, transactionStatus });
      const restarted = f.make(f.saved);
      await restarted.pollClose(SPEC.id); await restarted.prepareClose(SPEC.id); await restarted.close(SPEC.id);
      expect(f.closePosts).toBe(1);
      expect(f.saved.cycles[SPEC.id]!.positions[0]!.closes).toHaveLength(1);
      expect(f.saved.cycles[SPEC.id]!.positions[0]!.closes[0]!.phase).toBe("uncertain");
    }
  });

  test("mismatched failure evidence cannot authorize a new close", async () => {
    for (const invalid of [{ ownerCommitment: fieldHex(99n) }, { positionCommitment: fieldHex(99n) },
      { closeCommitment: fieldHex(99n) }, { marginOutputCommitment: fieldHex(99n) },
      { settlementTxHash: "not-a-hash" }, { transactionStatus: "NOT_FOUND" }]) {
      const f = fixture({ loseClose: true });
      await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id); f.addOpening(); await f.adapter.pollOpen(SPEC.id);
      await f.adapter.prepareClose(SPEC.id); await f.adapter.close(SPEC.id);
      f.setCloseStatus({ canRetry: true, transactionStatus: "FAILED", ...invalid });
      await expect(f.make(f.saved).pollClose(SPEC.id)).rejects.toThrow();
      expect(f.closePosts).toBe(1);
      expect(f.saved.cycles[SPEC.id]!.positions[0]!.closes[0]!.phase).toBe("uncertain");
    }
  });

  test("an older uncertain attempt blocks fresh preparation after a later failure", async () => {
    const f = fixture({ loseClose: true });
    await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id); f.addOpening(); await f.adapter.pollOpen(SPEC.id);
    await f.adapter.prepareClose(SPEC.id); await f.adapter.close(SPEC.id);
    const saved = structuredClone(f.saved);
    const attempts = saved.cycles[SPEC.id]!.positions[0]!.closes;
    attempts.push({ ...structuredClone(attempts[0]!), closeCommitment: fieldHex(99n), phase: "context-rejected" });
    const result = await f.make(saved).prepareClose(SPEC.id);
    expect(result.positions[0]!.closes).toHaveLength(2);
    expect(f.closePosts).toBe(1);
    expect(result.positions[0]!.closes[0]!.phase).toBe("uncertain");
  });

  test("lost custody relay response preserves the exact envelope/hash and never creates another deposit", async () => {
    const f = fixture();
    await f.adapter.prepareDeposit("deposit-001", "100000000");
    const deposit = await f.adapter.submitDeposit("deposit-001");
    expect(deposit.phase).toBe("uncertain");
    expect(deposit.txHash).toBe(TX);
    expect(deposit.signedXdr).toBe("c2lnbmVk");
    const restarted = f.make(f.saved);
    await restarted.submitDeposit("deposit-001");
    expect(f.relayPosts).toBe(1);
    expect(f.calls.filter((call) => call.path === "/notes/deposit-asset/prepare-proven").length).toBe(1);
  });

  test("a conclusively failed unfunded deposit retains its envelope and atomically stages one replacement note", async () => {
    const f = fixture();
    await f.adapter.prepareDeposit("deposit-001", "100000000");
    const original = await f.adapter.submitDeposit("deposit-001");
    f.setDepositStatus({ transactionStatus: "FAILED", canRetry: true });
    const resumed = f.make(f.saved);
    const recovered = await resumed.reconcileDeposit("deposit-001");
    expect(recovered.phase).toBe("preparing");
    expect(recovered.commitment).not.toBe(original.commitment);
    expect(recovered.txHash).toBeUndefined(); expect(recovered.signedXdr).toBeUndefined();
    expect(recovered.failedAttempts).toHaveLength(1);
    expect(recovered.failedAttempts![0]).toMatchObject({ commitment: original.commitment, txHash: original.txHash,
      signedXdr: original.signedXdr, prepared: original.prepared, error: original.error });
    expect(f.saved.notes.filter((note) => [original.commitment, recovered.commitment].includes(note.commitment)))
      .toHaveLength(2);
    expect(f.saved.notes.find((note) => note.commitment === original.commitment)!.status).toBe("pending");
    expect(f.relayPosts).toBe(1);
    expect(f.calls.filter((call) => call.path === "/notes/deposit-asset/prepare-proven")).toHaveLength(1);
    const restarted = f.make(f.saved);
    await restarted.reconcileDeposit("deposit-001");
    const prepared = await restarted.prepareDeposit("deposit-001", "100000000");
    expect(prepared.commitment).toBe(recovered.commitment);
    expect(prepared.failedAttempts).toHaveLength(1);
    expect(f.relayPosts).toBe(1);
  });

  test("deposit recovery rejects unknown, successful, funded or incorrectly bound status and retains the signed envelope", async () => {
    const cases = [
      { unavailable: true },
      { transactionStatus: "NOT_FOUND", canRetry: true }, { transactionStatus: "SUCCESS", canRetry: true },
      { transactionStatus: "FAILED", canRetry: false }, { transactionStatus: "FAILED", canRetry: true, from: "another-owner" },
      { transactionStatus: "FAILED", canRetry: true, token: "another-token" },
      { transactionStatus: "FAILED", canRetry: true, tokenDigest: ROOT },
      { transactionStatus: "FAILED", canRetry: true, amount: "999" },
      { transactionStatus: "FAILED", canRetry: true, commitment: ROOT },
      { transactionStatus: "FAILED", canRetry: true, expectedTxHash: CLOSE_TX },
    ];
    for (const status of cases) {
      const f = fixture(); await f.adapter.prepareDeposit("deposit-001", "100000000");
      const original = await f.adapter.submitDeposit("deposit-001");
      f.setDepositStatus(status);
      const result = await f.make(f.saved).reconcileDeposit("deposit-001");
      expect(result.phase).toBe("uncertain"); expect(result.commitment).toBe(original.commitment);
      expect(result.txHash).toBe(original.txHash); expect(result.signedXdr).toBe(original.signedXdr);
      expect(result.failedAttempts).toBeUndefined(); expect(f.relayPosts).toBe(1);
    }
  });

  test("confirmed unmatched cancellation returns the original funded note and abandons the uncreated change", async () => {
    const f = fixture();
    await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id); f.addUnmatched();
    const cancelled = await f.adapter.cancelOpen(SPEC.id);
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.cashReconciled).toBe(true);
    expect(f.saved.notes[0]!.status).toBe("available");
    expect(f.saved.notes.find((note) => note.commitment === cancelled.changeCommitment)!.status).toBe("spent");
    expect(f.cancelPosts).toBe(1);
  });

  test("XLM-only new-order guard leaves an existing BTC pilot state cancellable and recoverable", async () => {
    const f = fixture();
    await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id);
    // Restore the shape of the already accepted BTC pilot; new preparation is
    // prohibited, while recovery must continue to use its saved commitment.
    const legacy = f.saved;
    const cycle = legacy.cycles[SPEC.id]!;
    const oldCommitment = cycle.intentCommitment;
    cycle.spec.marketId = "btc-usd-perp"; cycle.intent.marketId = "btc-usd-perp";
    cycle.intentCommitment = commitIntent({ ...cycle.intent, limitPrice: BigInt(cycle.intent.limitPrice),
      margin: BigInt(cycle.intent.margin), size: BigInt(cycle.intent.size) } as TradeIntent);
    cycle.validity!.intentCommitment = cycle.intentCommitment;
    for (const note of legacy.notes) if (note.lockedByIntentCommitment === oldCommitment) note.lockedByIntentCommitment = cycle.intentCommitment;
    f.addUnmatched();
    const restored = f.make(legacy);
    const cancelled = await restored.cancelOpen(SPEC.id);
    expect(cancelled.spec.marketId).toBe("btc-usd-perp");
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.cashReconciled).toBe(true);
    expect(f.saved.notes[0]!.status).toBe("available");
    expect(f.cancelPosts).toBe(1);
    expect(f.intentPosts).toBe(1); // Recovery never opens another order.
  });

  test("uncertain cancellation is observation-only across restart until the saved order confirms", async () => {
    const f = fixture({ loseCancel: true });
    await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id); f.addUnmatched();
    await f.adapter.cancelOpen(SPEC.id);
    expect(f.saved.cycles[SPEC.id]!.cancellations![f.saved.cycles[SPEC.id]!.intentCommitment.toLowerCase()]!.phase).toBe("uncertain");
    const restarted = f.make(f.saved);
    await restarted.cancelOpen(SPEC.id);
    expect(f.cancelPosts).toBe(1);
    expect(f.saved.notes[0]!.status).toBe("locked");
    f.confirmCancellation();
    const cancelled = await restarted.pollOpen(SPEC.id);
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.cashReconciled).toBe(true);
  });

  test("residual cancellation preserves the live position; explicit recovery claims once and polls winning collateral", async () => {
    const f = fixture({ loseRefund: true });
    await f.adapter.prepareOpen(SPEC); await f.adapter.open(SPEC.id); f.addOpening(); f.addResidual();
    const cancelled = await f.adapter.cancelOpen(SPEC.id);
    expect(cancelled.phase).toBe("open");
    expect(cancelled.activeOrders.length).toBe(0);
    expect(cancelled.cashReconciled).toBe(false);
    expect(f.cancelPosts).toBe(1); // Historical partially-filled source is superseded.
    expect(f.refundPosts).toBe(0); // Polling/cancel never submit a collateral claim.
    await expect(f.adapter.recoverCash(SPEC.id)).rejects.toThrow("Close positions");
    await f.adapter.prepareClose(SPEC.id); await f.adapter.close(SPEC.id); f.confirmClose();
    const beforeRecovery = await f.adapter.pollClose(SPEC.id);
    expect(beforeRecovery.phase).toBe("closing");
    expect(beforeRecovery.cashReconciled).toBe(false);
    expect(f.refundPosts).toBe(0);
    const recovered = await f.adapter.recoverCash(SPEC.id);
    expect(recovered.phase).toBe("closed");
    expect(recovered.cashReconciled).toBe(true);
    expect(f.refundPosts).toBe(1);
    const restarted = f.make(f.saved);
    await restarted.recoverCash(SPEC.id);
    expect(f.refundPosts).toBe(1);
    expect(f.saved.notes.some((note) => note.amount === "50000000" && note.status === "available")).toBe(true);
  });

  test("confirmed accounting uses actual cash including entry fees, funding and paired payout caps", () => {
    const opening: any = { marketId: SPEC.marketId, positionCommitment: fieldHex(1n), positionNullifier: fieldHex(2n),
      side: "long", size: "100000000", entryPrice: "100000000", margin: "100000000", fundingIndex: "0", entryFee: "10000" };
    const record = { marketId: SPEC.marketId, positionCommitment: opening.positionCommitment,
      positionNullifier: opening.positionNullifier, markPrice: "400000000", currentFundingIndex: "1000000",
      proof: { circuitId: "position-close-pair" } };
    const capped = confirmedCloseAccounting(opening, record, "200000000");
    expect(capped.grossPricePnl).toBe("300000000");
    expect(capped.fundingPayment).toBe("1000000");
    expect(capped.netPnl).toBe("99990000");
    expect(capped.pairedPayoutAdjustment).toBe("-199000000");
    expect(capped.payoutCapped).toBe(true);
    expect(() => confirmedCloseAccounting(opening, record, "99000000")).toThrow("equity/collateral bounds");
    expect(() => confirmedCloseAccounting(opening, { ...record, proof: { circuitId: "position-close" } }, "200000000")).toThrow("paired position");
    const unknownFee = confirmedCloseAccounting({ ...opening, entryFee: undefined }, record, "200000000");
    expect(unknownFee.netPnl).toBeUndefined();
    expect(unknownFee.entryFee).toBeUndefined();
    expect(unknownFee.totalFees).toBeUndefined();
    expect(unknownFee.accountingComplete).toBe(false);
    const receivedFunding = confirmedCloseAccounting({ ...opening, side: "short" }, {
      ...record, markPrice: "100000000", currentFundingIndex: "1000000",
    }, "101000000");
    expect(receivedFunding.fundingPayment).toBe("-1000000");
    expect(receivedFunding.netPnl).toBe("990000");
  });
});
