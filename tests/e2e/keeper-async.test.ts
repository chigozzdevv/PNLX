import { describe, expect, test } from "bun:test";
import { commitConditionalOrder, digestToFieldHex, hashFields, ownerCommitment } from "@pnlx/crypto";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { ConditionalOrderWitness, Hex, PairedPositionCloseRecord, PositionCloseWitness, PrivateMatchIntent, ProofMeta } from "@pnlx/protocol-types";
import { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";
import { Router } from "@/shared/http/router";
import { createDelegatedConditionalPolicy } from "@/shared/protocol/delegated-policies";
import { ProtocolStore } from "@/shared/state/store";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { OnchainRelayService } from "@/workers/onchain/onchain.service";
import { ProtectionKeeperService } from "@/workers/protection-keeper/protection-keeper.service";
import { ProverService } from "@/workers/prover/prover.service";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";

const key = (label: string) => digestToFieldHex(`keeper-async:${label}`);
const proof = (id: string): ProofMeta => ({ circuitId: id, circuitKey: key(`${id}-key`), circuitHash: key(`${id}-source`),
  verifierHash: key(`${id}-vk`), publicInputHash: key(`${id}-inputs`), proofDigest: key(`${id}-proof`) });
const env = { conditionalOrdersOnchainRequired: true, settlementsOnchainRequired: true };
const relay = (functionName: string) => ({ relays: [{ functionName, submitted: true, txHash: key("confirmed-pair") }] });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("test operation stalled")), 2_000);
  })]); } finally { clearTimeout(timer); }
}

function fixture() {
  const store = new ProtocolStore();
  const executor = { store };
  const market = { marketId: "xlm-usd-perp", fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };
  const intents: PrivateMatchIntent[] = [1n, -1n].map((side, index) => ({ batchId: "async-pair", marketId: market.marketId,
    intentCommitment: key(`intent-${index}`), noteNullifier: key(`note-${index}`), ownerCommitment: ownerCommitment(`GOWNER${index}`),
    ownerDigest: key(`owner-field-${index}`), positionSeed: key(`private-seed-${index}`), noteChangeCommitment: "0x0",
    limitPrice: market.oraclePrice, margin: 200_000_000n, signedSize: side * 1_000_000_000n }));
  store.markets.set(market.marketId, market);
  const match = new BatchMatcherService().match({ batchId: "async-pair", market, intents });
  const settlement = { ...prepareRisc0SettlementDraft({ batchId: "async-pair", market, intents, match }), proof: proof("batch-match") };
  store.settlements.set("async-pair", settlement);
  for (const intent of intents) {
    store.privateMatchIntents.set(intent.intentCommitment, intent);
    store.intents.set(intent.intentCommitment, { ...intent, assetDigest: key("asset") } as never);
  }
  for (const fill of match.fills) {
    store.positionCommitments.add(fill.positionCommitment);
    store.positionLifecycle.set(fill.positionCommitment, { batchId: "async-pair", marketId: market.marketId,
      ownerCommitment: fill.ownerCommitment, positionCommitment: fill.positionCommitment, positionNullifier: fill.positionNullifier,
      sourceIntentCommitment: fill.intentCommitment, settlementDigest: settlement.settlementDigest, status: "open", openedAt: 1, updatedAt: 1 });
  }
  const position = [...store.positionLifecycle.values()].find((item) => item.sourceIntentCommitment === intents[0]!.intentCommitment)!;
  store.addDelegatedConditionalPolicy(createDelegatedConditionalPolicy({ stopLossPrice: "98000000", stopLossSalt: "private-stop" }, {
    intentCommitment: position.sourceIntentCommitment, marketId: market.marketId, ownerCommitment: position.ownerCommitment })!);
  market.oraclePrice = 95_000_000n;
  return { executor, store, market, position };
}

function runtime() {
  const f = fixture();
  const settled = new Set<Hex>();
  const indices = new Map<Hex, number>();
  let submissions = 0; let syncCalls = 0; let loseResponse = false;
  let held: { stage: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const pause = async (stage: string) => { if (held?.stage === stage) { held.entered.resolve(); await held.release.promise; } };
  const forbidden = () => { syncCalls++; throw new Error("synchronous keeper dependency invoked"); };
  const prover = {
    proveConditionalClose: forbidden, provePositionClosePair: forbidden,
    async proveConditionalCloseAsync(input: ConditionalOrderWitness) {
      await pause("conditional-proof");
      return { closeCommitment: commitConditionalOrder(input), marketId: input.marketId, markPrice: input.markPrice,
        positionNullifier: input.positionNullifier, proof: proof("conditional-close") };
    },
    async provePositionClosePairAsync(inputs: [PositionCloseWitness, PositionCloseWitness], maintenanceRate: bigint,
      liquidation: boolean): Promise<PairedPositionCloseRecord> {
      await pause("paired-proof");
      const pairedProof = proof("position-close-pair");
      return { marketId: inputs[0].marketId, assetDigest: inputs[0].marginOutputAssetDigest, markPrice: inputs[0].markPrice,
        currentFundingIndex: inputs[0].currentFundingIndex, maintenanceRate, liquidation, positionRoot: inputs[0].positionRoot,
        proof: pairedProof, positions: inputs.map(input => ({ marketId: input.marketId, markPrice: input.markPrice,
          currentFundingIndex: input.currentFundingIndex, positionRoot: input.positionRoot, positionCommitment: input.positionCommitment,
          positionNullifier: input.positionNullifier, closeCommitment: input.closeCommitment,
          newPositionCommitment: input.newPositionCommitment, marginOutputCommitment: input.marginOutputCommitment,
          proof: pairedProof })) as PairedPositionCloseRecord["positions"] };
    },
  };
  const onchain = {
    enabled: true, marketPrice: forbidden, marketFundingIndex: forbidden, registerConditionalOrder: forbidden,
    triggerConditionalClose: forbidden, isConditionalTriggered: forbidden, isPositionCloseSettled: forbidden,
    positionCloseAppendIndex: forbidden,
    async marketPriceAsync() { await pause("mark-read"); return f.market.oraclePrice; },
    async marketFundingIndexAsync() { await pause("funding-read"); return f.market.fundingIndex; },
    async registerConditionalOrderAsync() { await pause("registration"); return relay("register"); },
    async triggerConditionalCloseAsync() { await pause("trigger-relay"); return relay("trigger"); },
    async isConditionalTriggeredAsync() { return true; },
    async isPositionCloseSettledAsync(close: Hex) { await pause("settled-read"); return settled.has(close); },
    async positionCloseAppendIndexAsync(close: Hex) { await pause("index-read"); return indices.get(close)!; },
    async positionPairTransactionStatus() { await pause("transaction-read"); return "SUCCESS"; },
    async settleJournaledPositionPair(pair: PairedPositionCloseRecord, conditional: boolean,
      beforeSubmit: (prepared: { txHash: Hex; xdr: string }) => Promise<void>) {
      await beforeSubmit({ txHash: key("confirmed-pair"), xdr: "signed-pair-envelope" });
      await pause("pair-submit");
      submissions++;
      for (const [index, leg] of pair.positions.entries()) { settled.add(leg.closeCommitment); indices.set(leg.closeCommitment, 2 + index); }
      if (loseResponse) throw new Error("pair response lost after confirmation");
      return relay(conditional ? "settle_pair_conditional_proven" : "settle_pair_proven");
    },
  };
  const closes = new PositionClosesService(f.executor as never, prover as never, onchain as never, env);
  const conditional = new ConditionalOrdersService(f.executor as never, prover as never, env as never, onchain as never);
  const keeper = new ProtectionKeeperService(f.executor as never, closes, conditional, onchain as never);
  return { ...f, keeper, closes, onchain, prover,
    hold(stage: string) { held = { stage, entered: deferred(), release: deferred() }; return held; },
    setLostResponse(value: boolean) { loseResponse = value; }, submissions: () => submissions, syncCalls: () => syncCalls };
}

async function responsive(entered: Promise<void>, work: Promise<void>): Promise<void> {
  await deadline(entered);
  let completed = false; void work.then(() => { completed = true; });
  let ticked = false; const timer = setTimeout(() => { ticked = true; }, 0);
  const api = new Router(); api.add("GET", "/probe", () => Response.json({ ready: true }));
  const response = await deadline(delay(0).then(() => api.handle(new Request("http://pnlx.local/probe"))));
  clearTimeout(timer);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ready: true });
  expect(ticked).toBe(true); expect(completed).toBe(false);
}

describe("asynchronous protection cycle", () => {
  for (const stage of ["mark-read", "funding-read", "registration", "conditional-proof", "trigger-relay", "paired-proof", "pair-submit", "settled-read", "index-read"]) {
    test(`API and timers stay responsive while ${stage} waits`, async () => {
      const f = runtime(); const gate = f.hold(stage); const work = f.keeper.runOnce();
      try { await responsive(gate.entered.promise, work); }
      finally { gate.release.resolve(); await work; }
      expect(f.keeper.status.failures).toBe(0); expect(f.store.positionCloses.size).toBe(2);
      expect(f.submissions()).toBe(1); expect(f.syncCalls()).toBe(0);
    });
  }

  for (const stage of ["settled-read", "transaction-read", "index-read"]) {
    test(`confirmed-pair recovery stays responsive during ${stage} without resubmitting`, async () => {
      const f = runtime(); f.setLostResponse(true); await f.keeper.runOnce();
      expect(f.store.positionCloses.size).toBe(0); expect(f.submissions()).toBe(1);
      const gate = f.hold(stage); const work = f.closes.recoverPendingPairs();
      try { await responsive(gate.entered.promise, work); }
      finally { gate.release.resolve(); await work; }
      expect(f.store.positionCloses.size).toBe(2); expect(f.submissions()).toBe(1);
      expect(f.syncCalls()).toBe(0); expect([...f.store.pendingPairedCloses.values()][0]!.retiredReconciled).toBe(true);
    });
  }

  test("missing async readers fail closed without calling synchronous methods", async () => {
    const f = fixture(); let syncCalls = 0;
    const forbidden = () => { syncCalls++; throw new Error("sync path must not run"); };
    const onchain = { enabled: true, marketPrice: forbidden, marketFundingIndex: forbidden };
    const closes = { recoverPendingPairs: async () => {}, closeHosted: forbidden };
    const keeper = new ProtectionKeeperService(f.executor as never, closes as never, {} as never, onchain as never);
    await keeper.runOnce();
    expect(keeper.status.failures).toBe(2); expect(syncCalls).toBe(0); expect(f.store.positionCloses.size).toBe(0);
  });

  test("async confirmation readers reject malformed output and never use the sync relayer", async () => {
    let stdout: string | undefined = "true"; let syncCalls = 0;
    const onchain = new OnchainRelayService({ read() { syncCalls++; throw new Error("sync read"); },
      async readAsync() { await delay(0); return { stdout, output: "diagnostic true" }; } } as never,
      { enabled: true, deployment: { contracts: { "conditional-order": "conditional", "position-close": "close" } } } as never);
    for (const invalid of [undefined, "", "pending", "not true", '"true"', '{"value":true}']) {
      stdout = invalid;
      await expect(onchain.isConditionalTriggeredAsync("xlm-usd-perp", key("nullifier"), key("close"))).rejects.toThrow("invalid conditional trigger status");
      await expect(onchain.isPositionCloseSettledAsync(key("close"))).rejects.toThrow("invalid position close settlement status");
    }
    stdout = "false"; expect(await onchain.isPositionCloseSettledAsync(key("close"))).toBe(false);
    stdout = "true"; expect(await onchain.isConditionalTriggeredAsync("xlm-usd-perp", key("nullifier"), key("close"))).toBe(true);
    expect(syncCalls).toBe(0);
  });

  test("conditional proving yields and verifies the exact public input binding", async () => {
    const prover = new ProverService();
    const input: ConditionalOrderWitness = { marketId: "xlm-usd-perp", positionNullifier: key("proof-position"),
      side: "long", size: 1_000_000_000n, reduceOnly: true, kind: "stop-loss", triggerPrice: 98_000_000n,
      markPrice: 95_000_000n, salt: "async-private-stop" };
    let ticked = false; const timer = setTimeout(() => { ticked = true; }, 0);
    const record = await prover.proveConditionalCloseAsync(input); clearTimeout(timer);
    expect(ticked).toBe(true); expect(record.closeCommitment).toBe(commitConditionalOrder(input));
    const expected = contractPublicInputHash([publicField(hashFields("market-id", [input.marketId])),
      publicU128(input.markPrice), publicField(input.positionNullifier), publicField(record.closeCommitment)]);
    expect(record.proof.publicInputHash).toBe(expected);
    expect(() => prover.assertBoundProof(record.proof, "conditional-close", expected)).not.toThrow();
    const artifact = prover.artifactFor(record.proof);
    expect(artifact).toBeDefined();
    expect(artifact!.proofHash).toBe(record.proof.proofDigest);
    expect(artifact!.publicInputsHash).toBe(expected);
  }, 120_000);
});
