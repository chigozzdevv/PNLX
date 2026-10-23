import { describe, expect, test } from "bun:test";
import { commitConditionalOrder, digestToFieldHex, ownerCommitment } from "@pnlx/crypto";
import type { ConditionalOrderWitness, PairedPositionCloseRecord, PositionCloseWitness, PrivateMatchIntent, ProofMeta } from "@pnlx/protocol-types";
import { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";
import { hostedPositionCloseWitness } from "@/features/position-closes/paired-position-witness";
import { createDelegatedConditionalPolicy } from "@/shared/protocol/delegated-policies";
import { ProtocolStore } from "@/shared/state/store";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import { ProtectionKeeperService } from "@/workers/protection-keeper/protection-keeper.service";
import { prepareRisc0SettlementDraft } from "@/workers/risc0-matcher/risc0-proof";
import { OnchainRelayService } from "@/workers/onchain/onchain.service";

const key = (label: string) => digestToFieldHex(`keeper-retry:${label}`);
const env = { conditionalOrdersOnchainRequired: false, settlementsOnchainRequired: false };

describe("offline protection retries and authorization", () => {
  test("a lost trigger response and failed pair proof retry at a fresh mark without triggering twice", async () => {
    const { executor, store, position, market } = fixture();
    let pairProofs = 0;
    let triggerProofs = 0;
    let successfulTriggers = 0;
    let statusReads = 0;
    const settled = new Set<string>();
    const appendIndices = new Map<string, number>();
    const prover = {
      async proveConditionalCloseAsync(input: ConditionalOrderWitness) {
        triggerProofs++;
        return { closeCommitment: commitConditionalOrder(input), marketId: input.marketId,
          positionNullifier: input.positionNullifier, markPrice: input.markPrice, proof: proof("conditional-close") };
      },
      async provePositionClosePairAsync(inputs: [PositionCloseWitness, PositionCloseWitness], maintenanceRate: bigint): Promise<PairedPositionCloseRecord> {
        pairProofs++;
        if (pairProofs === 1) throw new Error("pair prover temporarily unavailable");
        const pairProof = proof("position-close-pair");
        return { marketId: inputs[0].marketId, assetDigest: inputs[0].marginOutputAssetDigest,
          currentFundingIndex: inputs[0].currentFundingIndex, markPrice: inputs[0].markPrice,
          maintenanceRate, liquidation: false, positionRoot: inputs[0].positionRoot, proof: pairProof,
          positions: [{ ...inputs[0], proof: pairProof }, { ...inputs[1], proof: pairProof }] };
      },
    };
    const onchain = {
      enabled: true, marketPriceAsync: async () => market.oraclePrice, marketFundingIndexAsync: async () => market.fundingIndex,
      async triggerConditionalCloseAsync() { successfulTriggers++; throw new Error("trigger response lost after confirmation"); },
      async isConditionalTriggeredAsync(marketId: string, positionNullifier: string, closeCommitment: string) {
        statusReads++;
        expect(marketId).toBe(position.marketId);
        expect(positionNullifier).toBe(position.positionNullifier);
        expect(store.conditionalOrders.has(closeCommitment as `0x${string}`)).toBe(true);
        return true;
      },
      registerConditionalOrderAsync: async () => ({ relays: [] }),
      isPositionCloseSettledAsync: async (commitment: string) => settled.has(commitment),
      positionCloseAppendIndexAsync: async (commitment: string) => appendIndices.get(commitment)!,
      positionPairTransactionStatus: async () => "SUCCESS",
      async settleJournaledPositionPair(pair: PairedPositionCloseRecord, _conditional: boolean,
        beforeSubmit: (prepared: { txHash: `0x${string}`; xdr: string }) => Promise<void>) {
        await beforeSubmit({ txHash: key("confirmed-pair"), xdr: "signed-pair" });
        const appendAt = store.positionCommitments.size;
        for (const [index, record] of pair.positions.entries()) {
          appendIndices.set(record.closeCommitment, appendAt + index);
          settled.add(record.closeCommitment);
        }
        return { relays: [] };
      },
    };
    const closes = new PositionClosesService(executor as never, prover as never, onchain as never, env);
    const conditional = new ConditionalOrdersService(executor as never, prover as never, env as never, onchain as never);
    const keeper = new ProtectionKeeperService(executor as never, closes, conditional, onchain as never);
    await keeper.runOnce();
    expect(triggerProofs).toBe(1);
    expect(pairProofs).toBe(1);
    expect(store.conditionalCloses.size).toBe(1);
    expect([...store.conditionalCloses.values()][0]!.triggerTxHash).toBeUndefined();
    expect(position.status).toBe("open");
    market.oraclePrice = 101_000_000n;
    await keeper.runOnce();
    expect(triggerProofs).toBe(1);
    expect(successfulTriggers).toBe(1);
    expect(statusReads).toBe(1);
    expect(pairProofs).toBe(2);
    expect(store.positionCloses.size).toBe(2);
    expect([...store.positionLifecycle.values()].every((item) => item.status === "closed")).toBe(true);
    expect([...store.positionCloses.values()].every((item) => item.markPrice === 101_000_000n)).toBe(true);
  });

  test("reads exact scoped trigger status and rejects ambiguous RPC output", () => {
    let output = "true";
    let request: { payload: { args: string[]; functionName: string; contractId: string } } | undefined;
    const onchain = new OnchainRelayService({ read(input: typeof request) { request = input; return { output }; } } as never,
      { enabled: true, deployment: { contracts: { "conditional-order": "conditional-contract" } } } as never);
    expect(onchain.isConditionalTriggered("xlm-usd-perp", key("position"), key("close"))).toBe(true);
    expect(request!.payload.functionName).toBe("is_triggered_for");
    expect(request!.payload.contractId).toBe("conditional-contract");
    expect(request!.payload.args).toContain(key("position").slice(2));
    expect(request!.payload.args).toContain(key("close").slice(2));
    output = "false";
    expect(onchain.isConditionalTriggered("xlm-usd-perp", key("position"), key("close"))).toBe(false);
    for (const ambiguous of ["not true", "pending", "", "{\"value\":true}"]) {
      output = ambiguous;
      expect(() => onchain.isConditionalTriggered("xlm-usd-perp", key("position"), key("close"))).toThrow("invalid conditional trigger status");
    }
  });

  test("an unknown or false trigger status preserves the original relay error without local activation", () => {
    for (const unknown of [false, true]) {
      const { executor, store, position, market } = fixture();
      const trigger = { marketId: market.marketId, positionNullifier: position.positionNullifier, side: "long" as const,
        size: 1_000_000_000n, reduceOnly: true, kind: "stop-loss" as const, triggerPrice: 98_000_000n,
        markPrice: market.oraclePrice, salt: "ambiguous-private-stop" };
      const closeCommitment = commitConditionalOrder(trigger);
      store.addConditionalOrder({ closeCommitment, marketId: market.marketId, positionNullifier: position.positionNullifier });
      const service = new ConditionalOrdersService(executor as never, {
        proveConditionalClose: () => ({ closeCommitment, marketId: market.marketId, positionNullifier: position.positionNullifier,
          markPrice: market.oraclePrice, proof: proof("conditional-close") }),
      } as never, env as never, { enabled: true, marketPrice: () => market.oraclePrice,
        triggerConditionalClose() { throw new Error("original trigger relay failure"); },
        isConditionalTriggered() { if (unknown) throw new Error("RPC unavailable"); return false; },
      } as never);
      expect(() => service.trigger(trigger)).toThrow("original trigger relay failure");
      expect(store.conditionalCloses.size).toBe(0);
      expect(store.positionCloses.size).toBe(0);
    }
  });

  test("liquidation proceeds before a broken conditional registration service", async () => {
    const { executor, position, market } = fixture();
    market.oraclePrice = 70_000_000n;
    const closes: unknown[][] = [];
    let registrations = 0;
    const keeper = new ProtectionKeeperService(executor as never, {
      recoverPendingPairs: async () => {}, closeHosted: async (...args: unknown[]) => { closes.push(args); },
    } as never, { register() { registrations++; throw new Error("conditional registry unavailable"); } } as never);
    await keeper.runOnce();
    expect(registrations).toBe(0);
    expect(closes).toHaveLength(1);
    expect(closes[0]![0]).toBe(position);
    expect(closes[0]!.slice(2)).toEqual([false, true]);
  });

  test("a different authenticated owner cannot produce or relay a trigger", async () => {
    const { executor, store, position, market } = fixture();
    let triggerProofs = 0;
    let triggerRelays = 0;
    const trigger = { marketId: market.marketId, positionNullifier: position.positionNullifier,
      side: "long" as const, size: 1_000_000_000n, reduceOnly: true, kind: "stop-loss" as const,
      triggerPrice: 98_000_000n, markPrice: market.oraclePrice, salt: "test-private-stop" };
    const close = hostedPositionCloseWitness({ store, position, markPrice: market.oraclePrice,
      currentFundingIndex: 0n, assetDigest: key("asset"), closeCommitment: commitConditionalOrder(trigger) }).witness;
    const service = new ConditionalOrdersService(executor as never, {
      proveConditionalClose() { triggerProofs++; throw new Error("must not prove"); },
    } as never, env as never, { triggerConditionalClose() { triggerRelays++; } } as never);
    await expect(service.execute({ close, trigger }, "GOTHEROWNER")).rejects.toThrow("position owner");
    expect(triggerProofs).toBe(0);
    expect(triggerRelays).toBe(0);
    expect(store.conditionalCloses.size).toBe(0);
    expect(store.positionCloses.size).toBe(0);
  });
});

function fixture() {
  const store = new ProtocolStore();
  const executor = { store };
  const market = { marketId: "xlm-usd-perp", fundingIndex: 0n, oraclePrice: 100_000_000n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };
  const intents: PrivateMatchIntent[] = [1n, -1n].map((side, index) => ({ batchId: "retry-pair", marketId: market.marketId,
    intentCommitment: key(`intent-${index}`), noteNullifier: key(`note-${index}`), ownerCommitment: ownerCommitment(`GOWNER${index}`),
    ownerDigest: key(`owner-${index}`), positionSeed: key(`private-seed-${index}`), noteChangeCommitment: "0x0",
    limitPrice: market.oraclePrice, margin: 200_000_000n, signedSize: side * 1_000_000_000n }));
  store.markets.set(market.marketId, market);
  const match = new BatchMatcherService().match({ batchId: "retry-pair", market, intents });
  const settlement = { ...prepareRisc0SettlementDraft({ batchId: "retry-pair", market, intents, match }), proof: proof("batch-match") };
  store.settlements.set("retry-pair", settlement);
  for (const intent of intents) {
    store.privateMatchIntents.set(intent.intentCommitment, intent);
    store.intents.set(intent.intentCommitment, { ...intent, assetDigest: key("asset") } as never);
  }
  for (const fill of match.fills) {
    store.positionCommitments.add(fill.positionCommitment);
    store.positionLifecycle.set(fill.positionCommitment, { batchId: "retry-pair", marketId: market.marketId,
      ownerCommitment: fill.ownerCommitment, positionCommitment: fill.positionCommitment, positionNullifier: fill.positionNullifier,
      sourceIntentCommitment: fill.intentCommitment, settlementDigest: settlement.settlementDigest, status: "open", openedAt: 1, updatedAt: 1 });
  }
  const position = [...store.positionLifecycle.values()].find((item) => item.sourceIntentCommitment === intents[0]!.intentCommitment)!;
  store.addDelegatedConditionalPolicy(createDelegatedConditionalPolicy({ stopLossPrice: "98000000", stopLossSalt: "private-stop" }, {
    intentCommitment: position.sourceIntentCommitment, marketId: market.marketId, ownerCommitment: position.ownerCommitment })!);
  market.oraclePrice = 95_000_000n;
  return { executor, store, market, position };
}

function proof(circuitId: string): ProofMeta {
  return { circuitId, circuitKey: key(`${circuitId}-key`), circuitHash: key(`${circuitId}-source`), verifierHash: key(`${circuitId}-vk`),
    publicInputHash: key(`${circuitId}-inputs`), proofDigest: key(`${circuitId}-proof`) };
}
