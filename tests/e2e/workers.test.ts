import { describe, expect, test } from "bun:test";
import {
  commitIntent,
  digestToFieldHex,
  hashFields,
  intentBindingFields,
  intentOwnerCommitmentField,
} from "@pnlx/crypto";
import { createECDH } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRICE_SCALE } from "@pnlx/market-math";
import type {
  BatchSettlement,
  Hex,
  IntentRecord,
  IntentValidityRecord,
  TradeIntent,
} from "@pnlx/protocol-types";
import { loadEnv } from "@/config/env";
import { BatchesService } from "@/features/batches/batches.service";
import { IntentsService } from "@/features/intents/intents.service";
import { MarketsService } from "@/features/markets/markets.service";
import {
  MarketDataService,
  parseHermesPriceUpdates,
} from "@/features/markets/market-data.service";
import { NotesService } from "@/features/notes/notes.service";
import { OrdersService } from "@/features/orders/orders.service";
import {
  positionOpeningAccountEventDataCommitment,
  positionOpeningAccountEventId,
} from "@/shared/protocol/account-event-binding";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { ProtocolStore } from "@/shared/state/store";
import { createBatchExecutor } from "@/workers/batch-executor/batch-executor.worker";
import { createExecutor } from "@/workers/executor/executor.worker";
import { ExecutorService } from "@/workers/executor/executor.service";
import { createMatcherApp } from "@/workers/matcher/matcher.app";
import { RemoteMatcherClient } from "@/workers/matcher/remote/matcher.service";
import { MatcherService } from "@/workers/matcher/matcher.service";
import { createMatcher } from "@/workers/matcher/matcher.worker";
import { createFundingEngine } from "@/workers/funding-engine/funding-engine.worker";
import { createIndexer } from "@/workers/indexer/indexer.worker";
import { createOnchainRelay } from "@/workers/onchain/onchain.worker";
import { OracleService } from "@/workers/oracle/oracle.service";
import type { SettlementProofInput } from "@/workers/proof-coordinator/proof-coordinator.model";
import { createRelayer } from "@/workers/relayer/relayer.worker";

describe("support workers", () => {
  test("parses aligned Pyth price stream updates", () => {
    const feedId = "b7a8eba68a997cd0210c2e1e4ee811ad2d174b3611c22d9ebf16f4cb7e9ba850";
    const updates = parseHermesPriceUpdates(JSON.stringify({
      parsed: [{
        id: feedId,
        price: {
          conf: "120",
          expo: -8,
          price: "19160237",
          publish_time: 1_784_692_964,
        },
      }],
    }), new Map([[feedId, "xlm-usd-perp"]]));

    expect(updates).toEqual([{
      confidence: 0.0000012,
      marketId: "xlm-usd-perp",
      price: 0.19160237,
      publishedAt: 1_784_692_964_000,
      source: "pyth-hermes",
    }]);
  });

  test("coalesces and caches Pyth candle snapshots", async () => {
    let requests = 0;
    const fetcher = async () => {
      requests += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({
        c: [0.19, 0.20],
        h: [0.195, 0.205],
        l: [0.185, 0.19],
        o: [0.188, 0.19],
        s: "ok",
        t: [1_784_692_000, 1_784_692_900],
        v: [0, 0],
      }), { status: 200 });
    };
    const service = new MarketDataService(loadEnv(), fetcher as never);
    const input = { interval: "15m" as const, limit: 160, marketId: "xlm-usd-perp" };

    const [first, concurrent] = await Promise.all([
      service.candles(input),
      service.candles(input),
    ]);
    const cached = await service.candles(input);

    expect(requests).toBe(1);
    expect(first.source).toBe("pyth-benchmarks");
    expect(first.cached).toBe(false);
    expect(concurrent.candles).toEqual(first.candles);
    expect(cached.cached).toBe(true);
    expect(cached.candles.at(-1)?.close).toBe(0.20);
  });

  test("defaults production oracle authority to on-chain market pricing", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRequired = process.env.ORACLE_ONCHAIN_REQUIRED;
    const previousSource = process.env.ORACLE_PRICE_SOURCE;
    const previousAuthSecret = process.env.AUTH_SESSION_SECRET;
    process.env.NODE_ENV = "production";
    process.env.AUTH_SESSION_SECRET = "pnlx-test-auth-session-secret-at-least-32-bytes";
    delete process.env.ORACLE_ONCHAIN_REQUIRED;
    delete process.env.ORACLE_PRICE_SOURCE;

    try {
      const env = loadEnv();
      expect(env.oracleOnchainRequired).toBe(true);
      expect(env.oraclePriceSource).toBe("onchain-market");
    } finally {
      restoreEnv("NODE_ENV", previousNodeEnv);
      restoreEnv("ORACLE_ONCHAIN_REQUIRED", previousRequired);
      restoreEnv("ORACLE_PRICE_SOURCE", previousSource);
      restoreEnv("AUTH_SESSION_SECRET", previousAuthSecret);
    }
  });

  test("preserves oracle publisher aliases while normalizing publisher addresses", () => {
    const previousSources = process.env.ORACLE_PUBLISHER_SOURCES;
    const previousAddresses = process.env.ORACLE_PUBLISHER_ADDRESSES;
    process.env.ORACLE_PUBLISHER_SOURCES = "pnlx-oracle-1,OracleTwo";
    process.env.ORACLE_PUBLISHER_ADDRESSES = "gpublishera,gpublisherb";

    try {
      const env = loadEnv();
      expect(env.oraclePublisherSources).toEqual(["pnlx-oracle-1", "OracleTwo"]);
      expect(env.oraclePublisherAddresses).toEqual(["GPUBLISHERA", "GPUBLISHERB"]);
    } finally {
      restoreEnv("ORACLE_PUBLISHER_SOURCES", previousSources);
      restoreEnv("ORACLE_PUBLISHER_ADDRESSES", previousAddresses);
    }
  });

  test("prefers matcher service env names while accepting legacy aliases", () => {
    const previousServiceUrl = process.env.MATCHER_SERVICE_URL;
    const previousServiceToken = process.env.MATCHER_SERVICE_TOKEN;
    const previousLegacyUrl = process.env.EXTERNAL_MATCHER_URL;
    const previousLegacyToken = process.env.EXTERNAL_MATCHER_TOKEN;

    try {
      delete process.env.MATCHER_SERVICE_URL;
      delete process.env.MATCHER_SERVICE_TOKEN;
      process.env.EXTERNAL_MATCHER_URL = "https://legacy-matcher.pnlx.local";
      process.env.EXTERNAL_MATCHER_TOKEN = "legacy-token";
      const legacyEnv = loadEnv();
      expect(legacyEnv.matcherServiceUrl).toBe("https://legacy-matcher.pnlx.local");
      expect(legacyEnv.matcherServiceToken).toBe("legacy-token");

      process.env.MATCHER_SERVICE_URL = "https://matcher.pnlx.local";
      process.env.MATCHER_SERVICE_TOKEN = "service-token";
      const preferredEnv = loadEnv();
      expect(preferredEnv.matcherServiceUrl).toBe("https://matcher.pnlx.local");
      expect(preferredEnv.matcherServiceToken).toBe("service-token");
    } finally {
      restoreEnv("MATCHER_SERVICE_URL", previousServiceUrl);
      restoreEnv("MATCHER_SERVICE_TOKEN", previousServiceToken);
      restoreEnv("EXTERNAL_MATCHER_URL", previousLegacyUrl);
      restoreEnv("EXTERNAL_MATCHER_TOKEN", previousLegacyToken);
    }
  });

  test("allows the production batch executor to be paused explicitly", () => {
    const previous = process.env.BATCH_EXECUTOR_ENABLED;
    try {
      process.env.BATCH_EXECUTOR_ENABLED = "false";
      expect(loadEnv().batchExecutorEnabled).toBe(false);
      process.env.BATCH_EXECUTOR_ENABLED = "true";
      expect(loadEnv().batchExecutorEnabled).toBe(true);
    } finally {
      restoreEnv("BATCH_EXECUTOR_ENABLED", previous);
    }
  });

  test("relays payloads and indexes public state", () => {
    const executor = createExecutor();
    const relayer = createRelayer();
    const indexer = createIndexer(executor.store);
    const commitment = hashFields("note", ["worker-test"]);

    const tx = relayer.relay({ kind: "deposit", payload: { commitment } });
    executor.deposit(commitment);
    const snapshot = indexer.snapshot();

    expect(tx.kind).toBe("deposit");
    expect(tx.mode).toBe("local");
    expect(tx.payloadDigest.startsWith("0x")).toBe(true);
    expect(tx.submitted).toBe(false);
    expect(tx.txHash).toBeUndefined();
    expect(snapshot.marginRoot.startsWith("0x")).toBe(true);
    expect(snapshot.spentNullifierCount).toBe(0);
  });

  test("requires proof ledger registration before private state mutation", () => {
    const store = new ProtocolStore();
    const proof = {
      circuitId: "withdraw",
      circuitKey: hashFields("circuit-id", ["withdraw"]),
      circuitHash: hashFields("circuit-source", ["withdraw"]),
      verifierHash: hashFields("verifier", ["withdraw"]),
      publicInputHash: hashFields("public-input", ["withdraw"]),
      proofDigest: hashFields("proof", ["withdraw"]),
    };
    const withdrawal = {
      root: hashFields("root", ["proof-ledger"]),
      nullifier: hashFields("nullifier", ["proof-ledger"]),
      recipient: hashFields("recipient", ["proof-ledger"]),
      tokenDigest: "0x0" as const,
      withdrawAmount: 1_000n,
      changeCommitment: "0x0" as const,
      proof,
    };

    expect(() => store.addWithdrawal(withdrawal)).toThrow("unverified proof");

    store.recordProof(proof);
    store.addWithdrawal(withdrawal);

    expect(store.hasProof(proof)).toBe(true);
    expect(store.withdrawals.has(withdrawal.nullifier)).toBe(true);
  });

  test("intent submissions do not become active without submitted on-chain registry tx when required", () => {
    const executor = createExecutor();
    const intent = backedIntent("intent-finality-submit", executor);
    const validity = intentValidity(executor, intent);
    const onchain = {
      enabled: true,
      submitIntent() {
        return { relays: [unsubmittedRelay("intent", "submit")] };
      },
    };
    const service = new IntentsService(
      executor,
      intentProver(validity) as never,
      onchain as never,
      { intentRegistryOnchainRequired: true },
    );

    expect(() => service.submit({ intent, validity })).toThrow("submit transaction was not submitted");
    expect(executor.store.intents.has(validity.intentCommitment)).toBe(false);
    expect(executor.store.orderLifecycle.has(validity.intentCommitment)).toBe(false);
  });

  test("order cancellations do not update local lifecycle without submitted registry tx when required", () => {
    const executor = createExecutor();
    const intent = backedIntent("intent-finality-cancel", executor);
    const validity = intentValidity(executor, intent);
    executor.store.recordProof(validity.proof);
    const record = executor.submitIntent({ intent, validity });
    const onchain = {
      enabled: true,
      cancelIntent() {
        return { relays: [unsubmittedRelay("intent", "cancel")] };
      },
    };
    const orders = new OrdersService(
      executor,
      intentProver(validity) as never,
      onchain as never,
      { intentRegistryOnchainRequired: true },
    );

    expect(() => orders.cancel({ intentCommitment: record.intentCommitment })).toThrow(
      "cancel transaction was not submitted",
    );
    expect(executor.store.orderLifecycle.get(record.intentCommitment)?.status).toBe("open");
  });

  test("persists protocol state across executor restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "pnlx-store-"));
    const storePath = join(dir, "protocol-store.json");
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 123n,
    };
    const proof = {
      circuitId: "batch-match",
      circuitKey: hashFields("circuit-id", ["batch-match"]),
      circuitHash: hashFields("circuit-source", ["batch-match"]),
      verifierHash: hashFields("verifier", ["batch-match"]),
      publicInputHash: hashFields("public-input", ["batch-match"]),
      proofDigest: hashFields("proof", ["batch-match"]),
    };
    const commitment = hashFields("commitment", ["persistent"]);
    const pendingCommitment = hashFields("commitment", ["persistent-pending-deposit"]);
    const depositProof = depositProofRecord(1_000n, pendingCommitment);

    const first = createFileExecutor(storePath);
    first.addMarket(market);
    first.deposit(commitment);
    first.store.recordProof(proof);
    first.store.addPendingAssetDeposit({
      amount: 1_000n,
      commitment: pendingCommitment,
      createdAt: Date.now(),
      depositProof,
      from: "GPERSISTENT",
      preparedXdrDigest: hashFields("prepared-asset-deposit-xdr", ["persistent-pending-deposit"]),
      token: "CUSDC",
      tokenDigest: depositProof.tokenDigest,
    });

    const second = createFileExecutor(storePath);

    expect(second.store.markets.get(market.marketId)?.oraclePrice).toBe(market.oraclePrice);
    expect(second.store.marginCommitments.has(commitment)).toBe(true);
    expect(second.store.hasProof(proof)).toBe(true);
    expect(second.store.pendingAssetDeposits.get(pendingCommitment)?.amount).toBe(1_000n);
  });

  test("accepts private matching required config with the RISC0 matcher path", () => {
    expect(() => createExecutor({ privateMatchingRequired: true })).not.toThrow();
  });

  test("persists private match payloads beside sealed public intent records", () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const record = submitBackedIntent(executor, matchedTradeIntent("private-payload-retry", "long", {
      batchId: "private-payload-batch",
      limitPrice: 50_000n * PRICE_SCALE,
      marketId: market.marketId,
    }));

    expect(record.matchingPayloadCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(executor.store.privateMatchIntents.get(record.intentCommitment)).toMatchObject({
      intentCommitment: record.intentCommitment,
      limitPrice: 50_000n * PRICE_SCALE,
      signedSize: 1n,
    });
    expect(JSON.stringify(record)).not.toContain((50_000n * PRICE_SCALE).toString());
  });

  test("commits externally proven blind settlement transcripts without private payload recovery", () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const long = intentRecord("external-long", market.marketId, executor.store.marginMembershipRoot());
    const short = intentRecord("external-short", market.marketId, executor.store.marginMembershipRoot());
    executor.store.recordProof(long.proof);
    executor.store.recordProof(short.proof);
    executor.store.addIntent(long);
    executor.store.addIntent(short);

    expect(() =>
      executor.createBatchSettlement({ batchId: "external-batch", marketId: market.marketId }),
    ).toThrow("private match payload not found");

    const settlement = externalSettlement({
      batchId: "external-batch",
      marketId: market.marketId,
      newCommitments: [
        hashFields("position", ["external-long"]),
        hashFields("position", ["external-short"]),
      ],
      orderUpdates: [
        { intentCommitment: long.intentCommitment, status: "filled" as const },
        { intentCommitment: short.intentCommitment, status: "filled" as const },
      ],
      spentNullifiers: [long.noteNullifier, short.noteNullifier],
      store: executor.store,
    });
    const positionOpenings = [
      positionOpening(settlement, long, settlement.newCommitments[0]),
      positionOpening(settlement, short, settlement.newCommitments[1]),
    ];
    const transcript = {
      accountEvents: accountEventsForOpenings(positionOpenings),
      settlement,
      positionOpenings,
    };
    expect(() => executor.commitExternalBatchSettlement(transcript)).toThrow(
      "external settlement proof is not verified",
    );

    executor.store.recordProof(settlement.proof);
    const result = executor.commitExternalBatchSettlement(transcript);

    expect(result.settlementDigest).toBe(settlement.settlementDigest);
    expect(executor.store.spentNullifiers.has(long.noteNullifier)).toBe(true);
    expect(executor.store.spentNullifiers.has(short.noteNullifier)).toBe(true);
    expect(executor.store.positionLifecycle.size).toBe(2);
    expect(executor.store.accountEvents.size).toBe(2);
    expect(JSON.stringify([...executor.store.accountEvents.values()])).not.toContain("positionNullifier");
    expect(executor.store.orderLifecycle.get(long.intentCommitment)?.status).toBe("filled");
  });

  test("rejects external settlements that omit encrypted owner account events", () => {
    const fixture = externalBatchFixture("missing-account-events");
    fixture.executor.store.recordProof(fixture.settlement.proof);

    expect(() =>
      fixture.executor.commitExternalBatchSettlement({
        accountEvents: [],
        settlement: fixture.settlement,
        positionOpenings: fixture.positionOpenings,
      }),
    ).toThrow("external position account event is required");
    expect(fixture.executor.store.settlements.size).toBe(0);
  });

  test("rejects external settlements with tampered encrypted owner account events", () => {
    const fixture = externalBatchFixture("tampered-account-events");
    fixture.executor.store.recordProof(fixture.settlement.proof);

    expect(() =>
      fixture.executor.commitExternalBatchSettlement({
        accountEvents: [
          {
            ...fixture.accountEvents[0],
            dataCommitment: hashFields("tampered-account-event", ["data"]),
          },
          fixture.accountEvents[1],
        ],
        settlement: fixture.settlement,
        positionOpenings: fixture.positionOpenings,
      }),
    ).toThrow("position account event data commitment mismatch");
    expect(fixture.executor.store.settlements.size).toBe(0);
  });

  test("indexes external settlements after a submitted verifier relay", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const long = intentRecord("relay-external-long", market.marketId, executor.store.marginMembershipRoot());
    const short = intentRecord("relay-external-short", market.marketId, executor.store.marginMembershipRoot());
    executor.store.recordProof(long.proof);
    executor.store.recordProof(short.proof);
    executor.store.addIntent(long);
    executor.store.addIntent(short);

    const settlement = externalSettlement({
      batchId: "external-batch",
      marketId: market.marketId,
      newCommitments: [
        hashFields("position", ["relay-external-long"]),
        hashFields("position", ["relay-external-short"]),
      ],
      orderUpdates: [
        { intentCommitment: long.intentCommitment, status: "filled" as const },
        { intentCommitment: short.intentCommitment, status: "filled" as const },
      ],
      spentNullifiers: [long.noteNullifier, short.noteNullifier],
      store: executor.store,
    });
    const service = new BatchesService(
      executor,
      {
        settleBatch(record: BatchSettlement) {
          expect(record).toBe(settlement);
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["verify"]),
                relayId: hashFields("relay", ["verify"]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["verify"]),
              },
            ],
          };
        },
      } as never,
    );

    const positionOpenings = [
      positionOpening(settlement, long, settlement.newCommitments[0]),
      positionOpening(settlement, short, settlement.newCommitments[1]),
    ];
    const result = await service.commitExternal({
      accountEvents: accountEventsForOpenings(positionOpenings),
      settlement,
      positionOpenings,
    });

    expect(result.settlementDigest).toBe(settlement.settlementDigest);
    expect(executor.store.hasProof(settlement.proof)).toBe(true);
    expect(executor.store.positionLifecycle.size).toBe(2);
    expect(executor.store.accountEvents.size).toBe(2);
  });

  test("accepts worker-produced RISC0 matcher transcripts through batch ingestion", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    submitBackedIntent(executor, matchedTradeIntent("worker-produced-long", "long", {
      batchId: "worker-produced-batch",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    submitBackedIntent(executor, matchedTradeIntent("worker-produced-short", "short", {
      batchId: "worker-produced-batch",
      limitPrice: 49_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const matcher = createProoflessMatcher(executor, {
      accountEventEncryptor: (payload) => `base64:test-encrypted:${payload.kind}`,
    });
    const service = new BatchesService(
      executor,
      {
        settleBatch(settlement: BatchSettlement) {
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", [settlement.settlementDigest]),
                relayId: hashFields("relay", [settlement.settlementDigest]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", [settlement.settlementDigest]),
              },
            ],
          };
        },
      } as never,
      [],
      false,
      { settlementsOnchainRequired: true },
    );

    const transcript = await matcher.createSettlementTranscript({
      batchId: "worker-produced-batch",
      marketId: market.marketId,
    });
    const result = await service.commitExternal(transcript);

    expect(transcript.settlement.proof.proofSystem).toBe("risc0-groth16");
    expect(result.settlementDigest).toBe(transcript.settlement.settlementDigest);
    expect(result.aggregateVolume).toBe(2n);
    expect(executor.store.positionLifecycle.size).toBe(2);
    expect(executor.store.accountEvents.size).toBe(2);
    expect([...executor.store.orderLifecycle.values()].every((order) => order.status === "filled")).toBe(true);
  });

  test("worker-produced external matcher transcripts encrypt owner events to registered account keys", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 9n,
    };
    executor.addMarket(market);
    const long = submitBackedIntent(executor, matchedTradeIntent("encrypted-worker-long", "long", {
      batchId: "encrypted-worker-batch",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const short = submitBackedIntent(executor, matchedTradeIntent("encrypted-worker-short", "short", {
      batchId: "encrypted-worker-batch",
      limitPrice: 49_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const now = Date.now();
    for (const record of [long, short]) {
      executor.store.upsertAccountEncryptionKey({
        algorithm: "ecdh-p256-aes-gcm",
        createdAt: now,
        ownerCommitment: record.ownerCommitment,
        publicKey: rawP256PublicKey(),
        updatedAt: now,
      });
    }
    const matcher = createProoflessMatcher(executor);

    const transcript = await matcher.createSettlementTranscript({
      batchId: "encrypted-worker-batch",
      marketId: market.marketId,
    });

    expect(transcript.accountEvents).toHaveLength(2);
    expect(transcript.accountEvents.every((event) =>
      event.ciphertext.startsWith("pnlx-account-event-v1:")
    )).toBe(true);
    expect(JSON.stringify(transcript.accountEvents)).not.toContain("positionNullifier");
    expect(transcript.settlement.proof.proofSystem).toBe("risc0-groth16");
  });

  test("worker-produced matcher carries forward open market intents across batches", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);

    const oldLong = submitBackedIntent(executor, matchedTradeIntent("stale-batch-long", "long", {
      batchId: "old-open-batch",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const oldShort = submitBackedIntent(executor, matchedTradeIntent("stale-batch-short", "short", {
      batchId: "old-open-batch",
      limitPrice: 49_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const currentLong = submitBackedIntent(executor, matchedTradeIntent("current-batch-long", "long", {
      batchId: "current-open-batch",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const currentShort = submitBackedIntent(executor, matchedTradeIntent("current-batch-short", "short", {
      batchId: "current-open-batch",
      limitPrice: 49_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    for (const record of [oldLong, oldShort, currentLong, currentShort]) {
      executor.store.upsertAccountEncryptionKey({
        algorithm: "ecdh-p256-aes-gcm",
        createdAt: 1,
        ownerCommitment: record.ownerCommitment,
        publicKey: rawP256PublicKey(),
        updatedAt: 1,
      });
    }

    const transcript = await createProoflessMatcher(executor).createSettlementTranscript({
      batchId: "current-open-batch",
      includeOpenMarketOrders: true,
      marketId: market.marketId,
    });

    expect(transcript.settlement.fillCount).toBe(4);
    expect(transcript.positionOpenings.map((opening) => opening.sourceIntentCommitment).sort()).toEqual([
      oldLong.intentCommitment,
      oldShort.intentCommitment,
      currentLong.intentCommitment,
      currentShort.intentCommitment,
    ].sort());
  });

  test("remote matcher client requests a separate matcher service", async () => {
    const fixture = externalBatchFixture("remote-matcher-client");
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://matcher.pnlx.local/match/jobs");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer remote-secret");
      return new Response(body({
        attempts: 1,
        jobId: "remote-matcher-job",
        status: "completed",
        transcript: {
          accountEvents: fixture.accountEvents,
          positionOpenings: fixture.positionOpenings,
          residualOrders: [],
          settlement: fixture.settlement,
        },
      }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    try {
      const client = new RemoteMatcherClient({
        token: "remote-secret",
        url: "https://matcher.pnlx.local",
      });
      const transcript = await client.createSettlementTranscript({
        batchId: fixture.settlement.batchId,
        marketId: fixture.settlement.marketId,
      });

      expect(transcript.settlement.settlementDigest).toBe(fixture.settlement.settlementDigest);
      expect(transcript.accountEvents).toHaveLength(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("matcher app produces transcripts from a separate persisted matcher process view", async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "pnlx-remote-matcher-")), "protocol-store.json");
    const executor = createFileExecutor(storePath);
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const long = submitBackedIntent(executor, matchedTradeIntent("remote-app-long", "long", {
      batchId: "remote-app-input",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const short = submitBackedIntent(executor, matchedTradeIntent("remote-app-short", "short", {
      batchId: "remote-app-input",
      limitPrice: 49_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    for (const record of [long, short]) {
      executor.store.upsertAccountEncryptionKey({
        algorithm: "ecdh-p256-aes-gcm",
        createdAt: 1,
        ownerCommitment: record.ownerCommitment,
        publicKey: rawP256PublicKey(),
        updatedAt: 1,
      });
    }

    const matcherApp = createMatcherApp({
      executor,
      signerConfig: {
        proofs: prooflessProofs(),
      },
      token: "matcher-token",
    });
    const response = await matcherApp.handle(
      new Request("http://matcher.local/match/settlement", {
        body: body({
          batchId: "remote-app-input",
          marketId: market.marketId,
        }),
        headers: {
          authorization: "Bearer matcher-token",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    const responseText = await response.text();
    if (response.status !== 201) {
      throw new Error(`matcher app failed with ${response.status}: ${responseText}`);
    }
    const transcript = JSON.parse(responseText) as Record<string, unknown>;
    expect((transcript.accountEvents as unknown[])).toHaveLength(2);
    expect(JSON.stringify(transcript.accountEvents)).not.toContain("positionNullifier");
  });

  test("batch executor automatically settles crossed private orders through matcher service", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const long = submitBackedIntent(executor, matchedTradeIntent("batch-executor-long", "long", {
      batchId: "ui-client-long-btc-usd-perp",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const short = submitBackedIntent(executor, matchedTradeIntent("batch-executor-short", "short", {
      batchId: "ui-client-short-btc-usd-perp",
      limitPrice: 49_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const now = Date.now();
    for (const record of [long, short]) {
      executor.store.upsertAccountEncryptionKey({
        algorithm: "ecdh-p256-aes-gcm",
        createdAt: now,
        ownerCommitment: record.ownerCommitment,
        publicKey: rawP256PublicKey(),
        updatedAt: now,
      });
    }
    const embeddedMatcher = createProoflessMatcher(executor);
    let releaseProof!: () => void;
    const proofGate = new Promise<void>((resolve) => {
      releaseProof = resolve;
    });
    const matcher = {
      async createSettlementTranscript(input: Parameters<typeof embeddedMatcher.createSettlementTranscript>[0]) {
        await proofGate;
        return embeddedMatcher.createSettlementTranscript(input);
      },
    };
    const batchExecutor = createBatchExecutor(
      executor,
      matcher,
      {
        batchIdPrefix: "runner",
        intervalMs: 1000,
        settlementsOnchainRequired: true,
      },
      {
        positionRoot() {
          return executor.store.positionMembershipRoot();
        },
        async settleBatchAsync(settlement: BatchSettlement) {
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", [settlement.settlementDigest]),
                relayId: hashFields("relay", [settlement.settlementDigest]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", [settlement.settlementDigest]),
              },
              {
                functionName: "settle",
                kind: "batch-settlement",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["settle", settlement.settlementDigest]),
                relayId: hashFields("relay", ["settle", settlement.settlementDigest]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["settle", settlement.settlementDigest]),
              },
            ],
          };
        },
      } as never,
    );

    const execution = batchExecutor.runOnce({ now: 1234 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...executor.store.batchExecutionRuns.values()][0]).toMatchObject({
      phase: "proving",
      status: "running",
    });
    releaseProof();
    const result = await execution;

    expect(result.results).toHaveLength(1);
    expect(result.results[0].record.status).toBe("settled");
    expect(result.results[0].record.batchId).toBe("runner-btc-usd-perp-1234");
    expect(result.results[0].record.fillCount).toBe(2);
    expect(executor.store.settlements.size).toBe(1);
    expect(executor.store.batchExecutionRuns.size).toBe(1);
    expect([...executor.store.settlements.values()][0]).toMatchObject({
      proofVerificationTxHash: expect.stringMatching(/^0x/),
      settlementTxHash: expect.stringMatching(/^0x/),
    });
    expect(executor.store.accountEvents.size).toBe(2);
    expect(executor.store.orderLifecycle.get(long.intentCommitment)?.status).toBe("filled");
    expect(executor.store.orderLifecycle.get(short.intentCommitment)?.status).toBe("filled");
  });

  test("batch executor fails before matching when the on-chain position root is out of sync", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    submitBackedIntent(executor, matchedTradeIntent("root-drift-long", "long", {
      batchId: "ui-root-drift",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    let matcherCalls = 0;
    const batchExecutor = createBatchExecutor(
      executor,
      {
        createSettlementTranscript() {
          matcherCalls += 1;
          throw new Error("matcher should not run");
        },
      },
      {
        batchIdPrefix: "runner",
        intervalMs: 1000,
        settlementsOnchainRequired: true,
      },
      {
        positionRoot() {
          return hashFields("position-root", ["different-on-chain-root"]);
        },
      } as never,
    );

    const result = await batchExecutor.runOnce({ now: 4321 });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].record.status).toBe("failed");
    expect(result.results[0].record.phase).toBe("matcher");
    expect(result.results[0].record.reason).toContain("position root out of sync");
    expect(matcherCalls).toBe(0);
    expect(executor.store.settlements.size).toBe(0);
  });

  test("batch executor commits locally when optional on-chain settlement relay fails", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const long = submitBackedIntent(executor, matchedTradeIntent("optional-relay-long", "long", {
      batchId: "optional-relay-batch",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const short = submitBackedIntent(executor, matchedTradeIntent("optional-relay-short", "short", {
      batchId: "optional-relay-batch",
      limitPrice: 49_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    for (const record of [long, short]) {
      executor.store.upsertAccountEncryptionKey({
        algorithm: "ecdh-p256-aes-gcm",
        createdAt: 1,
        ownerCommitment: record.ownerCommitment,
        publicKey: rawP256PublicKey(),
        updatedAt: 1,
      });
    }
    const batchExecutor = createBatchExecutor(
      executor,
      createProoflessMatcher(executor),
      {
        batchIdPrefix: "runner",
        intervalMs: 1000,
        settlementsOnchainRequired: false,
      },
      {
        settleBatch() {
          throw new Error("stellar relay failed: HostError: Error(WasmVm, InvalidAction)");
        },
      } as never,
    );

    const result = await batchExecutor.runOnce({ now: 2468 });

    expect(result.results[0].record.status).toBe("settled");
    expect(result.results[0].record.fillCount).toBe(2);
    expect(executor.store.settlements.size).toBe(1);
    expect(executor.store.orderLifecycle.get(long.intentCommitment)?.status).toBe("filled");
    expect(executor.store.orderLifecycle.get(short.intentCommitment)?.status).toBe("filled");
  });

  test("batch executor records skipped runs without mutating settlement state", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const long = submitBackedIntent(executor, matchedTradeIntent("batch-executor-skip-long", "long", {
      batchId: "runner-btc-usd-perp-5678",
      limitPrice: 49_000n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    executor.store.upsertAccountEncryptionKey({
      algorithm: "ecdh-p256-aes-gcm",
      createdAt: 1,
      ownerCommitment: long.ownerCommitment,
      publicKey: rawP256PublicKey(),
      updatedAt: 1,
    });
    const batchExecutor = createBatchExecutor(
      executor,
      createProoflessMatcher(executor),
      {
        batchIdPrefix: "runner",
        intervalMs: 1000,
        settlementsOnchainRequired: false,
      },
    );

    const result = await batchExecutor.runOnce({ now: 5678 });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].record.status).toBe("skipped");
    expect(result.results[0].record.reason).toContain("batch has no crossed liquidity");
    expect(executor.store.settlements.size).toBe(0);
    expect(executor.store.batchExecutionRuns.size).toBe(1);
    expect(executor.store.orderLifecycle.get(long.intentCommitment)?.status).toBe("open");
  });

  test("batch executor throttles oracle refresh across fast active-order loops", async () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    submitBackedIntent(executor, matchedTradeIntent("oracle-refresh-throttle-long", "long", {
      batchId: "ui-oracle-refresh-throttle",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const refreshes: string[] = [];
    const batchExecutor = createBatchExecutor(
      executor,
      createProoflessMatcher(executor),
      {
        batchIdPrefix: "runner",
        intervalMs: 1000,
        oracleRefreshIntervalMs: 60_000,
        refreshMarketOracle(marketId) {
          refreshes.push(marketId);
        },
      },
    );

    await batchExecutor.runOnce({ now: 1000 });
    await batchExecutor.runOnce({ now: 2000 });
    await batchExecutor.runOnce({ now: 61_000 });

    expect(refreshes).toEqual([
      market.marketId,
      market.marketId,
    ]);
  });

  test("batch executor keeps idle market oracle prices fresh", async () => {
    const executor = createExecutor();
    executor.addMarket({
      marketId: "xlm-usd-perp",
      oraclePrice: 20_000_000n,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    });
    const refreshes: string[] = [];
    const batchExecutor = createBatchExecutor(
      executor,
      createProoflessMatcher(executor),
      {
        intervalMs: 60_000,
        oracleRefreshIntervalMs: 10,
        refreshMarketOracle(marketId) {
          refreshes.push(marketId);
        },
      },
    );

    batchExecutor.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    batchExecutor.stop();

    expect(refreshes.length).toBeGreaterThanOrEqual(2);
    expect(refreshes.every((marketId) => marketId === "xlm-usd-perp")).toBe(true);
  });

  test("batch executor serializes oracle refreshes across markets", async () => {
    const executor = createExecutor();
    for (const marketId of ["btc-usd-perp", "xlm-usd-perp"]) {
      executor.addMarket({
        marketId,
        oraclePrice: 20_000_000n,
        maxLeverage: 10n,
        initialMarginRate: 100_000n,
        maintenanceMarginRate: 50_000n,
        fundingIndex: 0n,
      });
    }
    let active = 0;
    let maximumActive = 0;
    const refreshed: string[] = [];
    const batchExecutor = createBatchExecutor(
      executor,
      createProoflessMatcher(executor),
      {
        intervalMs: 60_000,
        oracleRefreshIntervalMs: 60_000,
        async refreshMarketOracle(marketId) {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          refreshed.push(marketId);
          active -= 1;
        },
      },
    );

    batchExecutor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    batchExecutor.stop();

    expect(maximumActive).toBe(1);
    expect(refreshed).toEqual(["btc-usd-perp", "xlm-usd-perp"]);
  });

  test("normalizes Pyth feed ids with or without a hex prefix", async () => {
    const originalFetch = globalThis.fetch;
    const requestedIds: string[] = [];
    globalThis.fetch = (input) => {
      const url = new URL(String(input));
      requestedIds.push(url.searchParams.get("ids[]") ?? "");
      return Promise.resolve(new Response(JSON.stringify({
        parsed: [{
          id: "abcd",
          price: { conf: "1", expo: -8, price: "20000000", publish_time: Math.floor(Date.now() / 1000) },
        }],
      }), { status: 200 }));
    };
    const oracle = new OracleService({
      hermesUrl: "https://hermes.example",
      maxAgeSeconds: 120,
      maxConfidenceBps: 100n,
      priceSource: "hermes",
    });

    try {
      await oracle.latest("abcd" as Hex);
      await oracle.latest("0xabcd" as Hex);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedIds).toEqual(["abcd", "abcd"]);
  });

  test("runs bounded funding engine cycles from market oracle price", () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const engine = createFundingEngine(executor, {
      intervalMs: 60 * 60 * 1000,
      maxFundingDelta: 3n,
      premiumRate: 100n,
    });

    const capped = engine.runOnce({
      appliedAt: 1_000,
      marketId: market.marketId,
    });

    expect(capped.results).toHaveLength(1);
    expect(capped.results[0].skipped).toBe(false);
    expect(capped.results[0].update?.fundingDelta).toBe(3n);
    expect(executor.store.markets.get(market.marketId)?.fundingIndex).toBe(3n);

    const uncapped = engine.runOnce({
      appliedAt: 2_000,
      elapsedMs: 60 * 60 * 1000,
      marketId: market.marketId,
      maxFundingDelta: 10n,
    });

    expect(uncapped.results[0].update?.oldFundingIndex).toBe(3n);
    expect(uncapped.results[0].update?.newFundingIndex).toBe(13n);

    const negative = engine.runOnce({
      appliedAt: 3_000,
      elapsedMs: 60 * 60 * 1000,
      marketId: market.marketId,
      maxFundingDelta: 2n,
      premiumRate: -100n,
    });

    expect(negative.results[0].update?.fundingDelta).toBe(-2n);
    expect(negative.results[0].update?.oldFundingIndex).toBe(13n);
    expect(negative.results[0].update?.newFundingIndex).toBe(11n);
  });

  test("live funding cycles prove and relay funding settlement before local index update", () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 4n,
    };
    const fundingProof = proof("funding-update");
    let proofInput: Record<string, unknown> | undefined;
    let relayed: Record<string, unknown> | undefined;
    executor.addMarket(market);
    const prover = {
      proveFundingSettlement(input: Record<string, unknown>) {
        proofInput = input;
        return {
          ...input,
          fundingDelta: BigInt(input.newFundingIndex as bigint) - BigInt(input.oldFundingIndex as bigint),
          proof: fundingProof,
        };
      },
    };
    const onchain = {
      enabled: true,
      settleFunding(record: Record<string, unknown>) {
        relayed = record;
        return { relays: [] };
      },
    };
    const engine = createFundingEngine(
      executor,
      {
        intervalMs: 60 * 60 * 1000,
        premiumRate: 100n,
      },
      prover as never,
      onchain as never,
    );

    const cycle = engine.runOnce({
      appliedAt: 9_000,
      elapsedMs: 60 * 60 * 1000,
      marketId: market.marketId,
      maxFundingDelta: 10n,
    });

    expect(cycle.results[0].skipped).toBe(false);
    expect(proofInput?.oldFundingIndex).toBe(4n);
    expect(proofInput?.newFundingIndex).toBe(14n);
    expect(proofInput?.markPrice).toBe(50_000n * PRICE_SCALE);
    expect(proofInput?.maxFundingDelta).toBe(10n);
    expect(relayed?.proof).toBe(fundingProof);
    expect(executor.store.markets.get(market.marketId)?.fundingIndex).toBe(14n);
  });

  test("funding cycles do not update local index without submitted on-chain settlement when required", () => {
    const executor = createExecutor();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 4n,
    };
    const fundingProof = proof("funding-update");
    executor.addMarket(market);
    const prover = {
      proveFundingSettlement(input: Record<string, unknown>) {
        return {
          ...input,
          fundingDelta: BigInt(input.newFundingIndex as bigint) - BigInt(input.oldFundingIndex as bigint),
          proof: fundingProof,
        };
      },
    };
    const onchain = {
      enabled: true,
      settleFunding() {
        return {
          relays: [
            {
              functionName: "settle",
              kind: "funding-settlement",
              mode: "local",
              payloadDigest: hashFields("payload", ["funding-unsubmitted"]),
              relayId: hashFields("relay", ["funding-unsubmitted"]),
              submitted: false,
              submittedAt: Date.now(),
            },
          ],
        };
      },
    };
    const engine = createFundingEngine(
      executor,
      {
        intervalMs: 60 * 60 * 1000,
        premiumRate: 100n,
        settlementsOnchainRequired: true,
      },
      prover as never,
      onchain as never,
    );

    expect(() =>
      engine.runOnce({
        appliedAt: 9_000,
        elapsedMs: 60 * 60 * 1000,
        marketId: market.marketId,
        maxFundingDelta: 10n,
      }),
    ).toThrow("settle transaction was not submitted");
    expect(executor.store.markets.get(market.marketId)?.fundingIndex).toBe(4n);
    expect(executor.store.fundingUpdates.size).toBe(0);
  });

  test("builds real stellar cli relay invocations", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        };
      },
    });

    const tx = relayer.relay({
      kind: "contract-invoke",
      payload: {
        args: ["--commitment", "0xabc"],
        contractId: "shielded-pool-contract",
        functionName: "deposit",
      },
    });

    expect(calls[0]).toEqual([
      "stellar",
      "contract",
      "invoke",
      "--id",
      "shielded-pool-contract",
      "--source",
      "pnlx-testnet",
      "--network",
      "testnet",
      "--send",
      "yes",
      "--auto-sign",
      "--",
      "deposit",
      "--commitment",
      "0xabc",
    ]);
    expect(tx.contractId).toBe("shielded-pool-contract");
    expect(tx.functionName).toBe("deposit");
    expect(tx.commandStatus).toBe(0);
    expect(tx.mode).toBe("stellar-cli");
    expect(tx.sendMode).toBe("yes");
    expect(tx.submitted).toBe(true);
    expect(tx.txHash).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  test("rejects submitted stellar cli output without a tx hash", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: () => ({
        status: 0,
        stderr: "",
        stdout: "transaction submitted successfully",
      }),
    });

    expect(() =>
      relayer.relay({
        kind: "contract-invoke",
        payload: {
          contractId: "shielded-pool-contract",
          functionName: "deposit",
        },
      }),
    ).toThrow("stellar relay did not return a transaction hash");
  });

  test("allows stellar cli simulation output without a tx hash", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: () => ({
        status: 0,
        stderr: "",
        stdout: "simulation completed successfully",
      }),
    });

    const tx = relayer.relay({
      kind: "contract-invoke",
      payload: {
        contractId: "shielded-pool-contract",
        functionName: "deposit",
        send: "no",
      },
    });

    expect(tx.commandOutputDigest?.startsWith("0x")).toBe(true);
    expect(tx.sendMode).toBe("no");
    expect(tx.submitted).toBe(false);
    expect(tx.txHash).toBeUndefined();
  });

  test("submits wallet-signed transaction envelopes through stellar cli", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "abc99900abc99900abc99900abc99900abc99900abc99900abc99900abc99900",
        };
      },
    });

    const tx = relayer.submitSignedXdr({
      expectedTxHash: "0xabc99900abc99900abc99900abc99900abc99900abc99900abc99900abc99900",
      xdr: "AAAA",
    });

    expect(calls[0]).toEqual(["stellar", "tx", "hash", "AAAA", "--network", "testnet"]);
    expect(calls[1]).toEqual(["stellar", "tx", "send", "AAAA", "--network", "testnet"]);
    expect(tx.command).toEqual(["stellar", "tx", "send", "<signed-xdr-redacted>", "--network", "testnet"]);
    expect(tx.kind).toBe("signed-xdr");
    expect(tx.functionName).toBe("tx send");
    expect(tx.submitted).toBe(true);
    expect(tx.txHash).toBe("0xabc99900abc99900abc99900abc99900abc99900abc99900abc99900abc99900");
  });

  test("normalizes failed wallet-signed stellar cli relay errors", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (_command, args) => {
        if (args[1] === "hash") {
          return {
            status: 0,
            stderr: "",
            stdout: "7e897199956b77aa908bf4a437baa41ff464909ec155b5fd93a9e5c28a306763",
          };
        }
        return {
          status: 1,
          stderr: [
            "ℹ️ Transaction hash is 7e897199956b77aa908bf4a437baa41ff464909ec155b5fd93a9e5c28a306763",
            "🔗 https://stellar.expert/explorer/testnet/tx/7e897199956b77aa908bf4a437baa41ff464909ec155b5fd93a9e5c28a306763",
            "❌ error: transaction submission failed: TxMalformed",
          ].join("\n"),
          stdout: "",
        };
      },
    });

    expect(() => relayer.submitSignedXdr({ xdr: "AAAA" })).toThrow(
      "Transaction rejected by Stellar: TxMalformed",
    );
  });

  test("parses stellar cli transaction hashes from stderr", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: () => ({
        status: 0,
        stderr: "Transaction hash: def11100def11100def11100def11100def11100def11100def11100def11100",
        stdout: "",
      }),
    });

    const tx = relayer.submitSignedXdr({ xdr: "AAAA" });

    expect(tx.submitted).toBe(true);
    expect(tx.txHash).toBe("0xdef11100def11100def11100def11100def11100def11100def11100def11100");
  });

  test("parses stellar cli transaction hashes from json output", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: () => ({
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          status: "SUCCESS",
          txHash: "123abc00123abc00123abc00123abc00123abc00123abc00123abc00123abc00",
        }),
      }),
    });

    const tx = relayer.submitSignedXdr({ xdr: "AAAA" });

    expect(tx.submitted).toBe(true);
    expect(tx.txHash).toBe("0x123abc00123abc00123abc00123abc00123abc00123abc00123abc00123abc00");
  });

  test("retries transient stellar cli sequence failures", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        if (calls.length === 1) {
          return {
            status: 1,
            stderr: "transaction submission failed: TxBadSeq",
            stdout: "",
          };
        }
        return {
          status: 0,
          stderr: "",
          stdout: "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
        };
      },
    });

    const tx = relayer.relay({
      kind: "contract-invoke",
      payload: {
        args: ["--commitment", "0xabc"],
        contractId: "shielded-pool-contract",
        functionName: "deposit",
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(tx.txHash).toBe("0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe");
  });

  test("builds domain on-chain relays for intent submit and cancel", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "facefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeed",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "intent-registry": "intent-registry-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {},
      },
      enabled: true,
    });
    const record = {
      batchDigest: digestToFieldHex("batch:intent-relay-batch"),
      batchId: "intent-relay-batch",
      marketDigest: digestToFieldHex("market:btc-usd-perp"),
      marketId: "btc-usd-perp",
      marginRoot: hashFields("margin-root", ["intent-relay"]),
      ownerCommitment: hashFields("owner", ["intent-relay"]),
      ownerCommitmentField: intentOwnerCommitmentField(hashFields("owner", ["intent-relay"])),
      intentCommitment: hashFields("intent", ["intent-relay"]),
      proof: proof("intent-validity"),
      matchingPayloadCommitment: hashFields("matching-payload", ["intent-relay"]),
      noteChangeCommitment: "0x0" as Hex,
      noteNullifier: hashFields("nullifier", ["intent-relay"]),
    };

    onchain.submitIntent(record);
    onchain.cancelIntent(record.intentCommitment);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("intent-registry-contract");
    expect(calls[0]).toContain("submit");
    expect(calls[0]).toContain(hashFields("batch-id", [record.batchId]).slice(2));
    expect(calls[0]).toContain(hashFields("market-id", [record.marketId]).slice(2));
    expect(calls[0]).toContain(record.intentCommitment.slice(2));
    expect(calls[0]).toContain(record.matchingPayloadCommitment.slice(2));
    expect(calls[1]).toContain("intent-registry-contract");
    expect(calls[1]).toContain("cancel");
    expect(calls[1]).toContain(record.intentCommitment.slice(2));
  });

  test("prepares wallet-signed stellar cli invocations", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
    });

    const command = relayer.prepare({
      kind: "deposit",
      payload: {
        args: [
          "--token",
          "usdc-token-contract",
          "--from",
          "GTRADER",
          "--amount",
          "25000000",
          "--commitment",
          "abc",
        ],
        buildOnly: true,
        contractId: "shielded-pool-contract",
        functionName: "deposit_asset",
        source: "GTRADER",
      },
    });

    expect(command).toEqual([
      "stellar",
      "contract",
      "invoke",
      "--id",
      "shielded-pool-contract",
      "--source",
      "GTRADER",
      "--network",
      "testnet",
      "--send",
      "no",
      "--build-only",
      "--",
      "deposit_asset",
      "--token",
      "usdc-token-contract",
      "--from",
      "GTRADER",
      "--amount",
      "25000000",
      "--commitment",
      "abc",
    ]);
    expect(command).not.toContain("--auto-sign");
  });

  test("builds domain on-chain relays for conditional close settlement", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        if (args.includes("mark_price")) {
          return {
            status: 0,
            stderr: "",
            stdout: JSON.stringify({ price: (56_000n * PRICE_SCALE).toString(), timestamp: 1_800_000_000 }),
          };
        }
        return {
          status: 0,
          stderr: "",
          stdout: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
        };
      },
    });
    const deployment = {
      contracts: {
        "conditional-order": "conditional-order-contract",
        market: "market-contract",
        "position-close": "position-close-contract",
      },
      network: "testnet",
      source: "pnlx-testnet",
      sourceAddress: "GTEST",
      verifiers: {
        "conditional-close-proof-verifier": "conditional-close-verifier",
        "position-close-proof-verifier": "position-close-verifier",
      },
    };
    const conditionalProof = proof("conditional-close");
    const positionProof = proof("position-close");
    const onchain = createOnchainRelay(relayer, {
      deployment,
      enabled: true,
      resolveProofArtifact: (proof) => ({
        proofPath: `/tmp/${proof.circuitId}/proof`,
        publicInputsPath: `/tmp/${proof.circuitId}/public_inputs`,
      }),
    });
    const marketId = "btc-usd-perp";
    const nullifier = hashFields("position-nullifier", ["worker-onchain"]);
    const closeCommitment = hashFields("close", ["worker-onchain"]);

    onchain.registerConditionalOrder({
      marketId,
      positionNullifier: nullifier,
      closeCommitment,
    });
    onchain.triggerConditionalClose({
      marketId,
      markPrice: 56_000n * PRICE_SCALE,
      positionNullifier: nullifier,
      closeCommitment,
      proof: conditionalProof,
    });
    onchain.settlePositionClose({
      marketId,
      markPrice: 56_000n * PRICE_SCALE,
      positionCommitment: hashFields("position", ["worker-onchain"]),
      positionNullifier: nullifier,
      positionRoot: hashFields("position-root", ["worker-onchain"]),
      closeCommitment,
      newPositionCommitment: hashFields("new-position", ["worker-onchain"]),
      marginOutputCommitment: hashFields("margin-output", ["worker-onchain"]),
      proof: positionProof,
    });

    expect(calls.map((call) => call[2])).toEqual([
      "invoke",
      "invoke",
      "invoke",
      "invoke",
      "invoke",
      "invoke",
      "invoke",
      "invoke",
      "invoke",
    ]);
    expect(calls[0]).toContain("conditional-order-contract");
    expect(calls[0]).toContain("register");
    expect(calls[1]).toContain("market-contract");
    expect(calls[1]).toContain("mark_price");
    expect(calls[2]).toContain("conditional-close-verifier");
    expect(calls[2]).toContain("verify_and_record");
    expect(calls[3]).toContain("market-contract");
    expect(calls[3]).toContain("mark_price");
    expect(calls[4]).toContain("conditional-order-contract");
    expect(calls[4]).toContain("trigger");
    expect(calls[4]).toContain((56_000n * PRICE_SCALE).toString());
    expect(calls[5]).toContain("market-contract");
    expect(calls[6]).toContain("position-close-verifier");
    expect(calls[6]).toContain("verify_and_record");
    expect(calls[7]).toContain("market-contract");
    expect(calls[8]).toContain("position-close-contract");
    expect(calls[8]).toContain("settle");
    expect(calls[8]).toContain(hashFields("market-id", [marketId]).slice(2));
    expect(calls[8]).toContain(hashFields("position-root", ["worker-onchain"]).slice(2));
    expect(calls[8]).toContain(hashFields("position", ["worker-onchain"]).slice(2));
    expect(calls[8]).toContain(nullifier.slice(2));
    expect(calls[8]).toContain((56_000n * PRICE_SCALE).toString());
  });

  test("builds domain on-chain relays for manual position close settlement", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        if (args.includes("mark_price")) {
          return {
            status: 0,
            stderr: "",
            stdout: JSON.stringify({ price: (56_000n * PRICE_SCALE).toString(), timestamp: 1_800_000_000 }),
          };
        }
        return {
          status: 0,
          stderr: "",
          stdout: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          market: "market-contract",
          "position-close": "position-close-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "position-close-proof-verifier": "position-close-verifier",
        },
      },
      enabled: true,
      resolveProofArtifact: (proof) => ({
        proofPath: `/tmp/${proof.circuitId}/proof`,
        publicInputsPath: `/tmp/${proof.circuitId}/public_inputs`,
      }),
    });
    const marketId = "btc-usd-perp";
    const nullifier = hashFields("position-nullifier", ["worker-manual-close"]);

    onchain.settleManualPositionClose({
      marketId,
      markPrice: 56_000n * PRICE_SCALE,
      positionCommitment: hashFields("position", ["worker-manual-close"]),
      positionNullifier: nullifier,
      positionRoot: hashFields("position-root", ["worker-manual-close"]),
      closeCommitment: hashFields("close", ["worker-manual-close"]),
      newPositionCommitment: hashFields("new-position", ["worker-manual-close"]),
      marginOutputCommitment: hashFields("margin-output", ["worker-manual-close"]),
      proof: proof("position-close"),
    });

    expect(calls.map((call) => call[2])).toEqual(["invoke", "invoke", "invoke", "invoke"]);
    expect(calls[0]).toContain("market-contract");
    expect(calls[1]).toContain("position-close-verifier");
    expect(calls[1]).toContain("verify_and_record");
    expect(calls[2]).toContain("market-contract");
    expect(calls[2]).toContain("mark_price");
    expect(calls[3]).toContain("position-close-contract");
    expect(calls[3]).toContain("settle_manual");
    expect(calls[3]).toContain(hashFields("market-id", [marketId]).slice(2));
    expect(calls[3]).toContain(nullifier.slice(2));
    expect(calls[3]).toContain((56_000n * PRICE_SCALE).toString());
  });

  test("stops a close after proof verification when the on-chain mark price moved", () => {
    const calls: string[][] = [];
    let priceReads = 0;
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        if (args.includes("mark_price")) {
          priceReads += 1;
          return {
            status: 0,
            stderr: "",
            stdout: JSON.stringify({
              price: priceReads === 1 ? "5600000000000" : "5599900000000",
              timestamp: 1_800_000_000,
            }),
          };
        }
        return {
          status: 0,
          stderr: "",
          stdout: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          market: "market-contract",
          "position-close": "position-close-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "position-close-proof-verifier": "position-close-verifier",
        },
      },
      enabled: true,
      resolveProofArtifact: () => ({
        proofPath: "/tmp/position-close/proof",
        publicInputsPath: "/tmp/position-close/public_inputs",
      }),
    });

    expect(() => onchain.settleManualPositionClose({
      marketId: "btc-usd-perp",
      markPrice: 56_000n * PRICE_SCALE,
      positionCommitment: hashFields("position", ["moved-price"]),
      positionNullifier: hashFields("position-nullifier", ["moved-price"]),
      positionRoot: hashFields("position-root", ["moved-price"]),
      closeCommitment: hashFields("close", ["moved-price"]),
      newPositionCommitment: hashFields("new-position", ["moved-price"]),
      marginOutputCommitment: hashFields("margin-output", ["moved-price"]),
      proof: proof("position-close"),
    })).toThrow("position close mark price mismatch: proof 5600000000000, on-chain 5599900000000");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("mark_price");
    expect(calls[1]).toContain("verify_and_record");
    expect(calls[2]).toContain("mark_price");
  });

  test("builds domain on-chain relays for batch settlement", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "batch-settlement": "batch-settlement-contract",
        },
        network: "testnet",
        risc0BatchMatchImageId: hashFields("risc0-image", ["batch-worker-onchain"]),
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "batch-match-risc0-verifier": "batch-match-risc0-verifier",
        },
      },
      enabled: true,
      resolveProofArtifact: (proof) => ({
        proofPath: `/tmp/${proof.circuitId}/proof`,
        publicInputsPath: `/tmp/${proof.circuitId}/public_inputs`,
      }),
    });
    const marketId = "btc-usd-perp";
    const batchId = "batch-worker-onchain";
    const sealDigest = hashFields("risc0-seal", [batchId]);
    const batchProof = {
      ...proof("batch-match"),
      imageId: hashFields("risc0-image", [batchId]),
      journalDigest: hashFields("risc0-journal", [batchId]),
      proofDigest: sealDigest,
      proofSystem: "risc0-groth16" as const,
      publicInputHash: hashFields("risc0-journal", [batchId]),
      sealDigest,
    };

    onchain.settleBatch({
      batchId,
      marketId,
      matchTranscriptDigest: hashFields("match-transcript", [batchId]),
      settlementDigest: hashFields("settlement-digest", [batchId]),
      newCommitments: [hashFields("position", [batchId])],
      marginChangeCommitments: [],
      spentNullifiers: [hashFields("nullifier", [batchId])],
      fillCount: 1,
      aggregateVolume: 50_000n,
      openInterestDelta: 1n,
      orderUpdates: [
        {
          intentCommitment: hashFields("intent", ["worker-onchain-a"]),
          status: "filled",
        },
        {
          intentCommitment: hashFields("intent", ["worker-onchain-b"]),
          status: "filled",
        },
      ],
      residualSize: 0n,
      proof: batchProof,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("batch-match-risc0-verifier");
    expect(calls[0]).toContain("verify_and_record");
    expect(calls[0]).toContain(`/tmp/batch-match/proof`);
    expect(calls[0]).toContain(batchProof.imageId!.slice(2));
    expect(calls[0]).toContain(batchProof.journalDigest!.slice(2));
    expect(calls[0]).toContain(batchProof.sealDigest!.slice(2));
    expect(calls[1]).toContain("batch-settlement-contract");
    expect(calls[1]).toContain("settle");
    expect(calls[1]).toContain(hashFields("batch-id", [batchId]).slice(2));
    expect(calls[1]).toContain(hashFields("market-id", [marketId]).slice(2));
    expect(calls[1]).toContain(hashFields("settlement-digest", [batchId]).slice(2));
    expect(calls[1]).toContain(
      JSON.stringify(
        [hashFields("intent", ["worker-onchain-a"]), hashFields("intent", ["worker-onchain-b"])].map(
          (value) => value.slice(2),
        ),
      ),
    );
    expect(calls[1]).toContain(JSON.stringify([hashFields("position", [batchId]).slice(2)]));
    expect(calls[1]).toContain(JSON.stringify([]));
    expect(calls[1]).toContain(JSON.stringify([hashFields("nullifier", [batchId]).slice(2)]));
    expect(calls[1]).toContain("50000");
    expect(calls[1]).toContain("0");
  });

  test("builds domain on-chain relays for funding settlement", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "funding-settlement": "funding-settlement-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "funding-update-proof-verifier": "funding-update-verifier",
        },
      },
      enabled: true,
      resolveProofArtifact: (proof) => ({
        proofPath: `/tmp/${proof.circuitId}/proof`,
        publicInputsPath: `/tmp/${proof.circuitId}/public_inputs`,
      }),
    });
    const fundingProof = proof("funding-update");

    onchain.settleFunding({
      appliedAt: 1_000,
      elapsedMs: 3_600_000,
      fundingDelta: 5n,
      intervalMs: 3_600_000,
      markPrice: 50_000n * PRICE_SCALE,
      marketId: "btc-usd-perp",
      maxFundingDelta: 10n,
      newFundingIndex: 9n,
      oldFundingIndex: 4n,
      premiumRate: 100n,
      proof: fundingProof,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("funding-update-verifier");
    expect(calls[0]).toContain("verify_and_record");
    expect(calls[0]).toContain(`/tmp/funding-update/public_inputs`);
    expect(calls[1]).toContain("funding-settlement-contract");
    expect(calls[1]).toContain("settle");
    expect(calls[1]).toContain(hashFields("market-id", ["btc-usd-perp"]).slice(2));
    expect(calls[1]).toContain("4");
    expect(calls[1]).toContain("9");
    expect(calls[1]).toContain((50_000n * PRICE_SCALE).toString());
    expect(calls[1]).toContain("100");
    expect(calls[1]).toContain("3600000");
    expect(calls[1]).toContain("10");
    expect(calls[1]).toContain("true");
  });

  test("builds domain on-chain relays for market upserts", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "baddad00baddad00baddad00baddad00baddad00baddad00baddad00baddad00",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          market: "market-contract",
          "price-oracle": "price-oracle-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {},
      },
      enabled: true,
    });

    onchain.upsertMarket(
      {
        marketId: "btc-usd-perp",
        oraclePrice: 50_000n * PRICE_SCALE,
        maxLeverage: 10n,
        initialMarginRate: 100_000n,
        maintenanceMarginRate: 50_000n,
        fundingIndex: 0n,
      },
      {
        oracleAssetSymbol: "BTC",
        oracleAssetType: "other",
        oracleKind: "sep40",
        oracleMaxAge: 120,
        oracleTwapRecords: 1,
        priceDecimals: 8,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("market-contract");
    expect(calls[0]).toContain("upsert_other");
    expect(calls[0]).toContain("price-oracle-contract");
    expect(calls[0]).toContain(hashFields("market-id", ["btc-usd-perp"]).slice(2));
    expect(calls[0]).toContain("BTC");
    expect(calls[0]).toContain("sep40");
    expect(calls[0]).toContain("10");
    expect(calls[0]).toContain("100000");
  });

  test("reads oracle price from on-chain market contract when configured", async () => {
    const calls: string[][] = [];
    const timestamp = Math.floor(Date.now() / 1000);
    const price = 51_250n * PRICE_SCALE;
    const oracle = new OracleService({
      hermesUrl: "https://hermes.example",
      marketContractId: "market-contract",
      maxAgeSeconds: 120,
      maxConfidenceBps: 100n,
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      priceSource: "onchain-market",
      rpcUrl: "https://rpc.example",
      source: "pnlx-reader",
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ price: price.toString(), timestamp }),
        };
      },
    });

    const result = await oracle.latestMarket({
      feedId: hashFields("feed", ["btc"]),
      marketId: "btc-usd-perp",
    });

    expect(result.price).toBe(price);
    expect(result.publishTime).toBe(timestamp);
    expect(result.source).toBe("onchain-market");
    expect(calls[0]).toEqual([
      "stellar",
      "contract",
      "invoke",
      "--id",
      "market-contract",
      "--source",
      "pnlx-reader",
      "--network",
      "testnet",
      "--rpc-url",
      "https://rpc.example",
      "--network-passphrase",
      "Test SDF Network ; September 2015",
      "--send",
      "no",
      "--",
      "mark_price",
      "--market_id",
      hashFields("market-id", ["btc-usd-perp"]).slice(2),
    ]);
  });

  test("market oracle creation publishes price before market upsert", async () => {
    const executor = createExecutor();
    const events: string[] = [];
    const price = 50_000n * PRICE_SCALE;
    const oracle = {
      latestMarket: async () => ({
        confidence: 10n,
        confidenceBps: 1n,
        feedId: hashFields("feed", ["btc"]),
        price,
        publishTime: 12345,
      }),
    };
    const onchain = {
      publishOraclePrice: (input: { price: bigint }) => {
        events.push(`publish:${input.price}`);
        return { relays: [] };
      },
      upsertMarket: (market: { marketId: string }) => {
        events.push(`market:${market.marketId}`);
        return { relays: [] };
      },
    };
    const env = {
      oracleAssetAddress: "",
      oracleAssetSymbol: "BTC",
      oracleAssetType: "other",
      oracleBeamFeeToken: "",
      oracleContractId: "price-oracle-contract",
      oracleKind: "sep40",
      oraclePriceDecimals: 8,
      oraclePriceMaxAgeSeconds: 120,
      oraclePriceSource: "hermes",
      oraclePublishMode: "committee",
      oraclePublisherAddresses: ["GPUBLISHERA", "GPUBLISHERB"],
      oraclePublisherSources: ["oracle-a", "oracle-b"],
      oracleCommitteeThreshold: 2,
      oracleTwapRecords: 1,
      protocolAdminAddresses: [],
      pythBtcUsdFeedId: hashFields("feed", ["default"]).slice(2),
      stellarOnchainRelay: true,
      stellarRelayerMode: "stellar-cli",
    };
    const service = new MarketsService(executor, oracle as never, env as never, onchain as never);

    const result = await service.createFromOracle({
      fundingIndex: 0n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      marketId: "btc-usd-perp",
      maxLeverage: 10n,
    });

    expect(events).toEqual([`publish:${price}`, "market:btc-usd-perp"]);
    expect(result.market.oraclePrice).toBe(price);
    expect(executor.store.markets.get("btc-usd-perp")?.oraclePrice).toBe(price);
  });

  test("market updates are durable and relay on-chain upserts", () => {
    const dir = mkdtempSync(join(tmpdir(), "pnlx-market-update-"));
    const storePath = join(dir, "protocol-store.json");
    const executor = createFileExecutor(storePath);
    const events: string[] = [];
    const initial = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 200_000n,
      maintenanceMarginRate: 100_000n,
      fundingIndex: 0n,
    };
    const updated = {
      ...initial,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      oraclePrice: 51_000n * PRICE_SCALE,
    };
    const onchain = {
      upsertMarket: (market: { marketId: string; maxLeverage: bigint }) => {
        events.push(`market:${market.marketId}:${market.maxLeverage}`);
        return { relays: [] };
      },
    };
    const env = {
      oracleAssetAddress: "",
      oracleAssetSymbol: "BTC",
      oracleAssetType: "other",
      oracleBeamFeeToken: "",
      oracleContractId: "price-oracle-contract",
      oracleKind: "sep40",
      oraclePriceDecimals: 8,
      oraclePriceMaxAgeSeconds: 120,
      oraclePriceSource: "hermes",
      oraclePublishMode: "committee",
      oraclePublisherAddresses: ["GPUBLISHERA", "GPUBLISHERB"],
      oraclePublisherSources: ["oracle-a", "oracle-b"],
      oracleCommitteeThreshold: 2,
      oracleTwapRecords: 1,
      protocolAdminAddresses: [],
      pythBtcUsdFeedId: hashFields("feed", ["default"]).slice(2),
      stellarOnchainRelay: true,
      stellarRelayerMode: "stellar-cli",
    };
    const service = new MarketsService(executor, {} as never, env as never, onchain as never);

    executor.addMarket(initial);
    const result = service.update(updated);
    const reloaded = createFileExecutor(storePath);

    expect(result).toEqual(updated);
    expect(events).toEqual(["market:btc-usd-perp:10"]);
    expect(reloaded.store.markets.get(initial.marketId)?.maxLeverage).toBe(10n);
    expect(reloaded.store.markets.get(initial.marketId)?.oraclePrice).toBe(updated.oraclePrice);
    expect(() => service.update({ ...updated, maintenanceMarginRate: 150_000n })).toThrow(
      "maintenance margin rate exceeds initial margin rate",
    );
  });

  test("oracle refresh updates an existing market price and publishes on-chain price", async () => {
    const executor = createExecutor();
    const events: string[] = [];
    const feedId = hashFields("feed", ["refresh"]);
    const price = 52_000n * PRICE_SCALE;
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 7n,
    };
    const oracle = {
      latestMarket: async (input: { feedId: string }) => {
        events.push(`feed:${input.feedId}`);
        return {
          confidence: 10n,
          confidenceBps: 1n,
          feedId,
          price,
          publishTime: 54321,
        };
      },
    };
    const onchain = {
      publishOraclePrice: (input: { price: bigint; timestamp: number }) => {
        events.push(`publish:${input.price}:${input.timestamp}`);
        return { relays: [] };
      },
    };
    const env = {
      oracleAssetAddress: "",
      oracleAssetSymbol: "BTC",
      oracleAssetType: "other",
      oracleBeamFeeToken: "",
      oracleContractId: "price-oracle-contract",
      oracleKind: "sep40",
      oraclePriceDecimals: 8,
      oraclePriceMaxAgeSeconds: 120,
      oraclePriceSource: "hermes",
      oraclePublishMode: "committee",
      oraclePublisherAddresses: ["GPUBLISHERA", "GPUBLISHERB"],
      oraclePublisherSources: ["oracle-a", "oracle-b"],
      oracleCommitteeThreshold: 2,
      oracleTwapRecords: 1,
      protocolAdminAddresses: [],
      pythBtcUsdFeedId: hashFields("feed", ["default"]).slice(2),
      stellarOnchainRelay: true,
      stellarRelayerMode: "stellar-cli",
    };
    const service = new MarketsService(executor, oracle as never, env as never, onchain as never);

    executor.addMarket(market);
    const result = await service.refreshFromOracle({ feedId, marketId: market.marketId });

    expect(events).toEqual([`feed:${feedId}`, `publish:${price}:54321`]);
    expect(result.market.oraclePrice).toBe(price);
    expect(result.market.fundingIndex).toBe(market.fundingIndex);
    expect(executor.store.markets.get(market.marketId)?.oraclePrice).toBe(price);
  });

  test("on-chain oracle market creation requires production committee publishing config", async () => {
    const executor = createExecutor();
    const oracle = {
      latestMarket: async () => {
        throw new Error("oracle should not be fetched before readiness");
      },
    };
    const onchain = {
      enabled: true,
      publishOraclePrice: () => ({ relays: [] }),
      upsertMarket: () => ({ relays: [] }),
    };
    const env = {
      oracleAssetAddress: "",
      oracleAssetSymbol: "BTC",
      oracleAssetType: "other",
      oracleBeamFeeToken: "",
      oracleContractId: "price-oracle-contract",
      oracleKind: "sep40",
      oraclePriceDecimals: 8,
      oraclePriceMaxAgeSeconds: 120,
      oraclePriceSource: "hermes",
      oraclePublishMode: "committee",
      oraclePublisherAddresses: [],
      oraclePublisherSources: ["oracle-a", "oracle-b"],
      oracleCommitteeThreshold: 2,
      oracleTwapRecords: 1,
      protocolAdminAddresses: [],
      pythBtcUsdFeedId: hashFields("feed", ["default"]).slice(2),
      stellarOnchainRelay: true,
    };
    const service = new MarketsService(executor, oracle as never, env as never, onchain as never);

    await expect(service.createFromOracle({
      fundingIndex: 0n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      marketId: "btc-usd-perp",
      maxLeverage: 10n,
    })).rejects.toThrow("oracle not ready for on-chain settlement");
  });

  test("on-chain oracle refresh does not republish server price", async () => {
    const executor = createExecutor();
    const events: string[] = [];
    const feedId = hashFields("feed", ["onchain-refresh"]);
    const price = 53_000n * PRICE_SCALE;
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 7n,
    };
    const oracle = {
      latestMarket: async (input: { feedId: string; marketId: string }) => {
        events.push(`onchain:${input.marketId}:${input.feedId}`);
        return {
          confidence: 0n,
          confidenceBps: 0n,
          feedId,
          price,
          publishTime: 54321,
          source: "onchain-market",
        };
      },
    };
    const onchain = {
      publishOraclePrice: (input: { price: bigint }) => {
        events.push(`publish:${input.price}`);
        return { relays: [] };
      },
    };
    const env = {
      oracleAssetAddress: "",
      oracleAssetSymbol: "BTC",
      oracleAssetType: "other",
      oracleBeamFeeToken: "",
      oracleContractId: "price-oracle-contract",
      oracleKind: "sep40",
      oraclePriceDecimals: 8,
      oraclePriceMaxAgeSeconds: 120,
      oraclePriceSource: "onchain-market",
      oraclePublishMode: "committee",
      oraclePublisherAddresses: [],
      oraclePublisherSources: [],
      oracleTwapRecords: 1,
      protocolAdminAddresses: [],
      pythBtcUsdFeedId: hashFields("feed", ["default"]).slice(2),
      stellarOnchainRelay: true,
      stellarRelayerMode: "stellar-cli",
    };
    const service = new MarketsService(executor, oracle as never, env as never, onchain as never);

    executor.addMarket(market);
    const result = await service.refreshFromOracle({ feedId, marketId: market.marketId });

    expect(events).toEqual([`onchain:${market.marketId}:${feedId}`]);
    expect(result.onchain).toBeUndefined();
    expect(result.market.oraclePrice).toBe(price);
  });

  test("disabled on-chain relay does not require oracle publisher config", async () => {
    const executor = createExecutor();
    const calls: string[][] = [];
    const price = 50_000n * PRICE_SCALE;
    const oracle = {
      latestMarket: async () => ({
        confidence: 10n,
        confidenceBps: 1n,
        feedId: hashFields("feed", ["btc"]),
        price,
        publishTime: 12345,
      }),
    };
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      enabled: false,
    });
    const env = {
      oracleAssetAddress: "",
      oracleAssetSymbol: "BTC",
      oracleAssetType: "other",
      oracleBeamFeeToken: "",
      oracleContractId: "price-oracle-contract",
      oracleKind: "sep40",
      oraclePriceDecimals: 8,
      oraclePriceMaxAgeSeconds: 120,
      oraclePublishMode: "committee",
      oraclePublisherAddresses: [],
      oraclePublisherSources: ["oracle-a"],
      oracleTwapRecords: 1,
      protocolAdminAddresses: [],
      pythBtcUsdFeedId: hashFields("feed", ["default"]).slice(2),
    };
    const service = new MarketsService(executor, oracle as never, env as never, onchain);

    const result = await service.createFromOracle({
      fundingIndex: 0n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      marketId: "btc-usd-perp",
      maxLeverage: 10n,
    });

    expect(result.market.oraclePrice).toBe(price);
    expect(result.onchain).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("builds domain on-chain oracle admin price publishes", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-admin",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "abc12300abc12300abc12300abc12300abc12300abc12300abc12300abc12300",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "price-oracle": "price-oracle-contract",
        },
        network: "testnet",
        source: "pnlx-admin",
        sourceAddress: "GADMIN",
        verifiers: {},
      },
      enabled: true,
    });

    onchain.publishOraclePrice({
      assetSymbol: "BTC",
      assetType: "other",
      price: 50_000n * PRICE_SCALE,
      publishMode: "admin",
      publishers: [],
      round: "1",
      timestamp: 12345,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("price-oracle-contract");
    expect(calls[0]).toContain("set_other_price");
    expect(calls[0]).toContain("--admin");
    expect(calls[0]).toContain("GADMIN");
    expect(calls[0]).toContain("--asset");
    expect(calls[0]).toContain("BTC");
    expect(calls[0]).toContain("--price");
    expect(calls[0]).toContain((50_000n * PRICE_SCALE).toString());
  });

  test("builds domain on-chain oracle committee price publishes", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-admin",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "def45600def45600def45600def45600def45600def45600def45600def45600",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "price-oracle": "price-oracle-contract",
        },
        network: "testnet",
        source: "pnlx-admin",
        sourceAddress: "GADMIN",
        verifiers: {},
      },
      enabled: true,
    });

    onchain.publishOraclePrice({
      assetSymbol: "XLM",
      assetType: "other",
      price: 12_345_678n,
      publishMode: "committee",
      publishers: [
        { address: "GPUBLISHERA", source: "oracle-a" },
        { address: "GPUBLISHERB", source: "oracle-b" },
      ],
      round: "99",
      timestamp: 23456,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--source");
    expect(calls[0]).toContain("oracle-a");
    expect(calls[0]).toContain("submit_other_price");
    expect(calls[0]).toContain("GPUBLISHERA");
    expect(calls[0]).toContain("--round");
    expect(calls[0]).toContain("99");
    expect(calls[1]).toContain("oracle-b");
    expect(calls[1]).toContain("GPUBLISHERB");
  });

  test("builds domain on-chain relays for asset deposits", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "facefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeed",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "shielded-pool": "shielded-pool-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "deposit-note-proof-verifier": "deposit-note-verifier-contract",
        },
      },
      enabled: true,
      resolveProofArtifact: (proof) => ({
        proofPath: `/tmp/${proof.circuitId}/proof`,
        publicInputsPath: `/tmp/${proof.circuitId}/public_inputs`,
      }),
    });
    const commitment = hashFields("note", ["asset-deposit"]);
    const depositProof = depositProofRecord(25_000_000n, commitment);

    const prepared = onchain.prepareDepositAsset({
      amount: 25_000_000n,
      commitment,
      depositProof,
      from: "GTRADER",
      token: "usdc-token-contract",
    });
    onchain.depositAsset({
      amount: 25_000_000n,
      commitment,
      depositProof,
      from: "GTRADER",
      source: "trader-alias",
      token: "usdc-token-contract",
    });

    expect(prepared.functionName).toBe("deposit_asset");
    expect(prepared.command).toContain("--build-only");
    expect(prepared.command).toContain("GTRADER");
    expect(prepared.command).toContain("--proof");
    expect(prepared.txHash).toBe("0xfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeed");
    expect(prepared.xdr).toBe("facefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeed");
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain("--build-only");
    expect(calls[0]).toContain("deposit_asset");
    expect(calls[1]).toContain("simulate");
    expect(calls[2]).toContain("hash");
    expect(calls[3]).toContain("deposit-note-verifier-contract");
    expect(calls[3]).toContain("verify_and_record");
    expect(calls[4]).toContain("shielded-pool-contract");
    expect(calls[4]).toContain("deposit_asset");
    expect(calls[4]).toContain("--source");
    expect(calls[4]).toContain("trader-alias");
    expect(calls[4]).toContain("--token");
    expect(calls[4]).toContain("usdc-token-contract");
    expect(calls[4]).toContain("--amount");
    expect(calls[4]).toContain("25000000");
    expect(calls[4]).toContain(commitment.slice(2));
    expect(calls[4]).toContain("--proof");
  });

  test("asset-backed deposit relay credits private margin membership", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: () => ({
        status: 0,
        stderr: "",
        stdout: "feed0000feed0000feed0000feed0000feed0000feed0000feed0000feed0000",
      }),
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "shielded-pool": "shielded-pool-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "deposit-note-proof-verifier": "deposit-note-verifier-contract",
        },
      },
      enabled: true,
      resolveProofArtifact: (proof) => ({
        proofPath: `/tmp/${proof.circuitId}/proof`,
        publicInputsPath: `/tmp/${proof.circuitId}/public_inputs`,
      }),
    });
    const executor = createExecutor();
    const commitment = hashFields("note", ["asset-backed-credit"]);
    const depositProof = depositProofRecord(25_000_000n, commitment);

    const relay = onchain.depositAsset({
      amount: 25_000_000n,
      commitment,
      depositProof,
      from: "GTRADER",
      token: "usdc-token-contract",
    });
    executor.deposit(commitment);

    expect(relay.relays[0].functionName).toBe("verify_and_record");
    expect(relay.relays[1].functionName).toBe("deposit_asset");
    expect(executor.store.marginCommitments.has(commitment)).toBe(true);
    expect(executor.store.marginMembershipProof(commitment).root).toBe(
      executor.store.marginMembershipRoot(),
    );
  });

  test("asset deposit preparation records the proof before returning a wallet action", () => {
    const executor = createExecutor();
    const env = {
      ...loadEnv(),
      assetCustodyRequired: true,
      collateralTokenContract: "CUSDC",
    };
    const events: string[] = [];
    const commitment = hashFields("note", ["custody-prepare-proof"]);
    const depositProof = depositProofRecord(25_000_000n, commitment);
    const service = new NotesService(
      executor,
      {
        proveDepositNote() {
          events.push("prove");
          return depositProof;
        },
      } as never,
      env,
      {
        enabled: true,
        assetBalance() {
          events.push("balance");
          return 25_000_000n;
        },
        prepareDepositAsset() {
          events.push("prepare");
          return {
            command: ["stellar", "contract", "invoke", "--build-only"],
            contractId: "shielded-pool-contract",
            functionName: "deposit_asset",
            kind: "deposit",
            payload: {
              contractId: "shielded-pool-contract",
              functionName: "deposit_asset",
            },
            xdr: "assetpreparedxdr",
          };
        },
        verifyProof(proofMeta: { proofDigest: Hex }) {
          events.push(`verify:${proofMeta.proofDigest}`);
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["custody-prepare-proof"]),
                relayId: hashFields("relay", ["custody-prepare-proof"]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["custody-prepare-proof"]),
              },
            ],
          };
        },
      } as never,
    );

    const result = service.prepareDepositAsset({
      amount: 25_000_000n,
      blinding: hashFields("blinding", ["custody-prepare-proof"]),
      commitment,
      from: "GTRADER",
      ownerDigest: hashFields("owner", ["custody-prepare-proof"]),
      rhoDigest: hashFields("rho", ["custody-prepare-proof"]),
      token: "CUSDC",
      tokenDigest: hashFields("token-digest", ["asset-deposit"]),
    });

    expect(events).toEqual(["balance", "prove", `verify:${depositProof.proof.proofDigest}`, "prepare"]);
    expect(result.depositProof).toBe(depositProof);
    expect(result.proofVerification.relays[0].functionName).toBe("verify_and_record");
    expect(result.proofVerification.relays[0].submitted).toBe(true);
    expect(result.action.functionName).toBe("deposit_asset");
    expect(result.pendingDeposit.commitment).toBe(commitment);
    expect(result.pendingDeposit.preparedXdrDigest).toBe(
      hashFields("prepared-asset-deposit-xdr", ["assetpreparedxdr"]),
    );
  });

  test("asset deposit preparation explains missing collateral trustline before proving", () => {
    const executor = createExecutor();
    const env = {
      ...loadEnv(),
      assetCustodyRequired: true,
      collateralAssetCode: "USDC",
      collateralTokenContract: "CUSDC",
    };
    const events: string[] = [];
    const commitment = hashFields("note", ["custody-missing-trustline"]);
    const service = new NotesService(
      executor,
      {
        proveDepositNote() {
          events.push("prove");
          return depositProofRecord(25_000_000n, commitment);
        },
      } as never,
      env,
      {
        enabled: true,
        assetBalance() {
          events.push("balance");
          throw new Error("stellar contract read failed: USDC trustline is missing for this wallet");
        },
        prepareDepositAsset() {
          events.push("prepare");
          throw new Error("should not prepare");
        },
        verifyProof() {
          events.push("verify");
          throw new Error("should not verify");
        },
      } as never,
    );

    expect(() =>
      service.prepareDepositAsset({
        amount: 25_000_000n,
        blinding: hashFields("blinding", ["custody-missing-trustline"]),
        commitment,
        from: "GTRADER",
        ownerDigest: hashFields("owner", ["custody-missing-trustline"]),
        rhoDigest: hashFields("rho", ["custody-missing-trustline"]),
        token: "CUSDC",
        tokenDigest: hashFields("token-digest", ["custody-missing-trustline"]),
      }),
    ).toThrow("USDC trustline is missing for this wallet");
    expect(events).toEqual(["balance"]);
  });

  test("custody-required wallet finalization needs a recorded submitted signed deposit relay", () => {
    const executor = createExecutor();
    const env = {
      ...loadEnv(),
      assetCustodyRequired: true,
      collateralTokenContract: "CUSDC",
    };
    const commitment = hashFields("note", ["wallet-finalize-required"]);
    const depositProof = depositProofRecord(25_000_000n, commitment);
    const service = new NotesService(
      executor,
      {
        proveDepositNote() {
          return depositProof;
        },
        assertBoundProof() {},
      } as never,
      env,
      {
        enabled: true,
        assetBalance() {
          return 25_000_000n;
        },
        prepareDepositAsset() {
          return {
            command: ["stellar", "contract", "invoke", "--build-only"],
            contractId: "shielded-pool-contract",
            functionName: "deposit_asset",
            kind: "deposit",
            payload: {},
            xdr: "walletfinalizexdr",
          };
        },
        verifyProof() {
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["wallet-finalize-required"]),
                relayId: hashFields("relay", ["wallet-finalize-required"]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["wallet-finalize-required"]),
              },
            ],
          };
        },
      } as never,
      {
        find() {
          return {
            commitment,
            functionName: "tx send",
            kind: "signed-xdr",
            mode: "stellar-cli",
            payloadDigest: hashFields("payload", ["wallet-finalize-missing"]),
            preparedXdrDigest: hashFields("prepared-asset-deposit-xdr", ["walletfinalizexdr"]),
            relayId: hashFields("relay", ["wallet-finalize-missing"]),
            submitted: false,
            submittedAt: Date.now(),
          };
        },
      } as never,
    );

    const prepared = service.prepareDepositAsset({
      amount: 25_000_000n,
      blinding: hashFields("blinding", ["wallet-finalize-required"]),
      commitment,
      from: "GTRADER",
      ownerDigest: hashFields("owner", ["wallet-finalize-required"]),
      rhoDigest: hashFields("rho", ["wallet-finalize-required"]),
      token: "CUSDC",
      tokenDigest: hashFields("token-digest", ["asset-deposit"]),
    });

    expect(() =>
      service.finalizeDepositAsset({
        amount: 25_000_000n,
        commitment,
        depositProof: prepared.depositProof,
        from: "GTRADER",
        relayId: hashFields("relay", ["wallet-finalize-missing"]),
        token: "CUSDC",
      }),
    ).toThrow("deposit_asset transaction was not submitted");
    expect(executor.store.marginCommitments.has(commitment)).toBe(false);
  });

  test("custody-required wallet finalization credits private margin from a matching signed relay", () => {
    const executor = createExecutor();
    const env = {
      ...loadEnv(),
      assetCustodyRequired: true,
      collateralTokenContract: "CUSDC",
    };
    const commitment = hashFields("note", ["wallet-finalize-ok"]);
    const relayId = hashFields("relay", ["wallet-finalize-ok"]);
    const depositProof = depositProofRecord(25_000_000n, commitment);
    const service = new NotesService(
      executor,
      {
        proveDepositNote() {
          return depositProof;
        },
        assertBoundProof() {},
      } as never,
      env,
      {
        enabled: true,
        assetBalance() {
          return 25_000_000n;
        },
        prepareDepositAsset() {
          return {
            command: ["stellar", "contract", "invoke", "--build-only"],
            contractId: "shielded-pool-contract",
            functionName: "deposit_asset",
            kind: "deposit",
            payload: {},
            xdr: "walletfinalizeokxdr",
          };
        },
        verifyProof() {
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["wallet-finalize-ok"]),
                relayId: hashFields("relay", ["wallet-finalize-verify-ok"]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["wallet-finalize-verify-ok"]),
              },
            ],
          };
        },
      } as never,
      {
        find() {
          return {
            commitment,
            functionName: "tx send",
            kind: "signed-xdr",
            mode: "stellar-cli",
            payloadDigest: hashFields("payload", ["wallet-finalize-ok"]),
            preparedXdrDigest: hashFields("prepared-asset-deposit-xdr", ["walletfinalizeokxdr"]),
            relayId,
            submitted: true,
            submittedAt: Date.now(),
            txHash: hashFields("tx", ["wallet-finalize-ok"]),
          };
        },
      } as never,
    );

    const prepared = service.prepareDepositAsset({
      amount: 25_000_000n,
      blinding: hashFields("blinding", ["wallet-finalize-ok"]),
      commitment,
      from: "GTRADER",
      ownerDigest: hashFields("owner", ["wallet-finalize-ok"]),
      rhoDigest: hashFields("rho", ["wallet-finalize-ok"]),
      token: "CUSDC",
      tokenDigest: hashFields("token-digest", ["asset-deposit"]),
    });
    const result = service.finalizeDepositAsset({
      amount: 25_000_000n,
      commitment,
      depositProof: prepared.depositProof,
      from: "GTRADER",
      relayId,
      token: "CUSDC",
    });

    expect(result.commitment).toBe(commitment);
    expect(result.onchain.relays[0].relayId).toBe(relayId);
    expect(executor.store.marginCommitments.has(commitment)).toBe(true);
    expect(typeof executor.store.pendingAssetDeposits.get(commitment)?.finalizedAt).toBe("number");
  });

  test("custody-required deposits need a submitted deposit_asset transaction before local credit", () => {
    const executor = createExecutor();
    const env = {
      ...loadEnv(),
      assetCustodyRequired: true,
      collateralTokenContract: "CUSDC",
    };
    const commitment = hashFields("note", ["custody-submit-required"]);
    const service = new NotesService(
      executor,
      {
        proveDepositNote() {
          return depositProofRecord(25_000_000n, commitment);
        },
      } as never,
      env,
      {
        enabled: true,
        assetBalance() {
          return 25_000_000n;
        },
        depositAsset() {
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "local",
                payloadDigest: hashFields("payload", ["custody-verify-local"]),
                relayId: hashFields("relay", ["custody-verify-local"]),
                submitted: false,
                submittedAt: Date.now(),
              },
              {
                functionName: "deposit_asset",
                kind: "deposit",
                mode: "local",
                payloadDigest: hashFields("payload", ["custody-deposit-local"]),
                relayId: hashFields("relay", ["custody-deposit-local"]),
                submitted: false,
                submittedAt: Date.now(),
              },
            ],
          };
        },
      } as never,
    );

    expect(() =>
      service.depositAsset({
        amount: 25_000_000n,
        blinding: hashFields("blinding", ["custody-submit-required"]),
        commitment,
        from: "GTRADER",
        ownerDigest: hashFields("owner", ["custody-submit-required"]),
        rhoDigest: hashFields("rho", ["custody-submit-required"]),
        token: "CUSDC",
        tokenDigest: hashFields("token-digest", ["custody-submit-required"]),
      }),
    ).toThrow("deposit_asset transaction was not submitted");
    expect(executor.store.marginCommitments.has(commitment)).toBe(false);
  });

  test("custody-required deposits credit private margin after a submitted deposit_asset transaction", () => {
    const executor = createExecutor();
    const env = {
      ...loadEnv(),
      assetCustodyRequired: true,
      collateralTokenContract: "CUSDC",
    };
    const commitment = hashFields("note", ["custody-submit-ok"]);
    const service = new NotesService(
      executor,
      {
        proveDepositNote() {
          return depositProofRecord(25_000_000n, commitment);
        },
      } as never,
      env,
      {
        enabled: true,
        assetBalance() {
          return 25_000_000n;
        },
        depositAsset() {
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["custody-verify-ok"]),
                relayId: hashFields("relay", ["custody-verify-ok"]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["custody-verify-ok"]),
              },
              {
                functionName: "deposit_asset",
                kind: "deposit",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["custody-deposit-ok"]),
                relayId: hashFields("relay", ["custody-deposit-ok"]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["custody-deposit-ok"]),
              },
            ],
          };
        },
      } as never,
    );

    const result = service.depositAsset({
      amount: 25_000_000n,
      blinding: hashFields("blinding", ["custody-submit-ok"]),
      commitment,
      from: "GTRADER",
      ownerDigest: hashFields("owner", ["custody-submit-ok"]),
      rhoDigest: hashFields("rho", ["custody-submit-ok"]),
      token: "CUSDC",
      tokenDigest: hashFields("token-digest", ["custody-submit-ok"]),
    });

    expect(result.commitment).toBe(commitment);
    expect(executor.store.marginCommitments.has(commitment)).toBe(true);
  });

  test("custody-required withdrawals need a submitted withdraw_asset transaction before local spend", () => {
    const executor = createExecutor();
    const env = {
      ...loadEnv(),
      assetCustodyRequired: true,
      collateralTokenContract: "CUSDC",
    };
    const note = hashFields("note", ["custody-withdraw-submit-required"]);
    const nullifier = hashFields("nullifier", ["custody-withdraw-submit-required"]);
    executor.deposit(note);
    const service = new NotesService(
      executor,
      {
        assertBoundProof() {},
      } as never,
      env,
      {
        enabled: true,
        withdrawAsset() {
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "local",
                payloadDigest: hashFields("payload", ["custody-withdraw-verify-local"]),
                relayId: hashFields("relay", ["custody-withdraw-verify-local"]),
                submitted: false,
                submittedAt: Date.now(),
              },
              {
                functionName: "withdraw_asset",
                kind: "withdraw",
                mode: "local",
                payloadDigest: hashFields("payload", ["custody-withdraw-local"]),
                relayId: hashFields("relay", ["custody-withdraw-local"]),
                submitted: false,
                submittedAt: Date.now(),
              },
            ],
          };
        },
      } as never,
    );

    expect(() =>
      service.withdrawAssetProven({
        changeCommitment: "0x0",
        nullifier,
        proof: proof("withdraw"),
        recipient: hashFields("recipient", ["custody-withdraw-submit-required"]),
        recipientAddress: "GRECIPIENT",
        root: executor.store.marginMembershipRoot(),
        token: "CUSDC",
        tokenDigest: hashFields("token-digest", ["custody-withdraw-submit-required"]),
        withdrawAmount: 1_000_000n,
      }),
    ).toThrow("withdraw_asset transaction was not submitted");
    expect(executor.store.spentNullifiers.has(nullifier)).toBe(false);
  });

  test("custody-required withdrawals spend locally after a submitted withdraw_asset transaction", () => {
    const executor = createExecutor();
    const env = {
      ...loadEnv(),
      assetCustodyRequired: true,
      collateralTokenContract: "CUSDC",
    };
    const note = hashFields("note", ["custody-withdraw-submit-ok"]);
    const nullifier = hashFields("nullifier", ["custody-withdraw-submit-ok"]);
    executor.deposit(note);
    const service = new NotesService(
      executor,
      {
        assertBoundProof() {},
      } as never,
      env,
      {
        enabled: true,
        withdrawAsset() {
          return {
            relays: [
              {
                functionName: "verify_and_record",
                kind: "contract-invoke",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["custody-withdraw-verify-ok"]),
                relayId: hashFields("relay", ["custody-withdraw-verify-ok"]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["custody-withdraw-verify-ok"]),
              },
              {
                functionName: "withdraw_asset",
                kind: "withdraw",
                mode: "stellar-cli",
                payloadDigest: hashFields("payload", ["custody-withdraw-ok"]),
                relayId: hashFields("relay", ["custody-withdraw-ok"]),
                submitted: true,
                submittedAt: Date.now(),
                txHash: hashFields("tx", ["custody-withdraw-ok"]),
              },
            ],
          };
        },
      } as never,
    );

    const result = service.withdrawAssetProven({
      changeCommitment: "0x0",
      nullifier,
      proof: proof("withdraw"),
      recipient: hashFields("recipient", ["custody-withdraw-submit-ok"]),
      recipientAddress: "GRECIPIENT",
      root: executor.store.marginMembershipRoot(),
      token: "CUSDC",
      tokenDigest: hashFields("token-digest", ["custody-withdraw-submit-ok"]),
      withdrawAmount: 1_000_000n,
    });

    expect(result.nullifier).toBe(nullifier);
    expect(executor.store.spentNullifiers.has(nullifier)).toBe(true);
  });

  test("rejects asset deposit relay when the custody proof is not bound to the note", () => {
    const relayer = createRelayer();
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "shielded-pool": "shielded-pool-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "deposit-note-proof-verifier": "deposit-note-verifier-contract",
        },
      },
      enabled: true,
      resolveProofArtifact: (proof) => ({
        proofPath: `/tmp/${proof.circuitId}/proof`,
        publicInputsPath: `/tmp/${proof.circuitId}/public_inputs`,
      }),
    });
    const commitment = hashFields("note", ["asset-deposit-bound"]);

    expect(() =>
      onchain.depositAsset({
        amount: 25_000_000n,
        commitment,
        depositProof: depositProofRecord(24_000_000n, commitment),
        from: "GTRADER",
        token: "usdc-token-contract",
      }),
    ).toThrow("asset deposit proof amount mismatch");
  });

  test("builds domain on-chain relays for asset withdrawals", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "pnlx-testnet",
      },
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return {
          status: 0,
          stderr: "",
          stdout: "decafbaddecafbaddecafbaddecafbaddecafbaddecafbaddecafbaddecafbad",
        };
      },
    });
    const onchain = createOnchainRelay(relayer, {
      deployment: {
        contracts: {
          "shielded-pool": "shielded-pool-contract",
        },
        network: "testnet",
        source: "pnlx-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "withdraw-proof-verifier": "withdraw-verifier-contract",
        },
      },
      enabled: true,
      resolveProofArtifact: (proof) => ({
        proofPath: `/tmp/${proof.circuitId}/proof`,
        publicInputsPath: `/tmp/${proof.circuitId}/public_inputs`,
      }),
    });
    const withdrawProof = proof("withdraw");
    const root = hashFields("root", ["asset-withdraw"]);
    const nullifier = hashFields("nullifier", ["asset-withdraw"]);
    const changeCommitment = hashFields("change", ["asset-withdraw"]);

    onchain.withdrawAsset({
      root,
      nullifier,
      recipient: hashFields("recipient-digest", ["asset-withdraw"]),
      recipientAddress: "GRECIPIENT",
      token: "usdc-token-contract",
      tokenDigest: hashFields("token-digest", ["asset-withdraw"]),
      withdrawAmount: 15_000_000n,
      changeCommitment,
      proof: withdrawProof,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("withdraw-verifier-contract");
    expect(calls[0]).toContain("verify_and_record");
    expect(calls[1]).toContain("shielded-pool-contract");
    expect(calls[1]).toContain("withdraw_asset");
    expect(calls[1]).toContain("usdc-token-contract");
    expect(calls[1]).toContain(root.slice(2));
    expect(calls[1]).toContain(nullifier.slice(2));
    expect(calls[1]).toContain("GRECIPIENT");
    expect(calls[1]).toContain("15000000");
    expect(calls[1]).toContain(changeCommitment.slice(2));
  });
});

function body(data: unknown): BodyInit {
  return JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

function bigintStringify(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function proof(circuitId: string) {
  return {
    circuitId,
    circuitKey: hashFields("circuit-id", [circuitId]),
    circuitHash: hashFields("circuit-source", [circuitId]),
    verifierHash: hashFields("verifier", [circuitId]),
    publicInputHash: hashFields("public-input", [circuitId]),
    proofDigest: hashFields("proof", [circuitId]),
  };
}

function backedIntent(seed: string, executor: ReturnType<typeof createExecutor>): TradeIntent {
  const marketId = "btc-usd-perp";
  if (!executor.store.markets.has(marketId)) {
    executor.addMarket({
      marketId,
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    });
  }
  executor.deposit(hashFields("margin-note", [seed]));
  return {
    batchId: "intent-finality-batch",
    limitPrice: 50_000n * PRICE_SCALE,
    margin: 10_000n,
    marketId,
    noteNullifier: hashFields("note-nullifier", [seed]),
    nonce: `${seed}-nonce`,
    owner: `G${seed.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(55, "A").slice(0, 55)}`,
    salt: `${seed}-salt`,
    side: "long",
    size: 1n,
  };
}

function matchedTradeIntent(
  seed: string,
  side: "long" | "short",
  options: { batchId: string; limitPrice: bigint; marketId: string },
): TradeIntent {
  return {
    batchId: options.batchId,
    limitPrice: options.limitPrice,
    margin: 10_000n,
	    marketId: options.marketId,
	    noteNullifier: hashFields("note-nullifier", [seed]),
	    nonce: `${seed}-nonce`,
	    owner: `G${seed.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(55, "A").slice(0, 55)}`,
	    salt: `${seed}-salt`,
	    side,
    size: 1n,
  };
}

function submitBackedIntent(executor: ReturnType<typeof createExecutor>, intent: TradeIntent): IntentRecord {
  executor.deposit(hashFields("margin-note", [intent.noteNullifier]));
  const validity = intentValidity(executor, intent);
  executor.store.recordProof(validity.proof);
  return executor.submitIntent({ intent, validity });
}

function intentValidity(
  executor: ReturnType<typeof createExecutor>,
  intent: TradeIntent,
): IntentValidityRecord {
  const intentCommitment = commitIntent(intent);
  const binding = intentBindingFields(intent);
  const noteCommitment = hashFields("note-commitment", [intentCommitment]);
  return {
    batchDigest: binding.batchDigest,
    currentBatch: 1n,
    expiryBatch: 2n,
    intentCommitment,
    marketDigest: binding.marketDigest,
    marginRoot: executor.store.marginMembershipRoot(),
    noteChangeCommitment: "0x0",
    noteCommitment,
    noteNullifier: intent.noteNullifier,
    ownerCommitmentField: binding.ownerCommitmentField,
    proof: proof("intent-validity"),
  };
}

function intentProver(validity: IntentValidityRecord) {
  return {
    assertBoundProof() {},
    intentValidityFor(proofMeta: { proofDigest: Hex }) {
      return proofMeta.proofDigest === validity.proof.proofDigest ? validity : undefined;
    },
  };
}

function unsubmittedRelay(kind: string, functionName: string) {
  return {
    functionName,
    kind,
    mode: "local",
    payloadDigest: hashFields("payload", [kind, functionName]),
    relayId: hashFields("relay", [kind, functionName]),
    submitted: false,
    submittedAt: Date.now(),
  };
}

function intentRecord(seed: string, marketId: string, marginRoot: Hex, batchId = "external-batch"): IntentRecord {
  const intentCommitment = hashFields("intent", [seed]);
  return {
    batchDigest: hashFields("batch-digest", [seed]),
    batchId,
    intentCommitment,
    marketDigest: hashFields("market-digest", [marketId]),
    marketId,
    marginRoot,
    noteChangeCommitment: "0x0",
    noteNullifier: hashFields("note-nullifier", [seed]),
    ownerCommitment: hashFields("owner", [seed]),
    ownerCommitmentField: hashFields("owner-field", [seed]),
    proof: proof("intent-validity"),
    matchingPayloadCommitment: hashFields("matching-payload", [seed]),
  };
}

function externalSettlement(input: {
  batchId: string;
  marketId: string;
  newCommitments: Hex[];
  orderUpdates: BatchSettlement["orderUpdates"];
  spentNullifiers: Hex[];
  store: ProtocolStore;
}): BatchSettlement {
  const draft = {
    aggregateVolume: BigInt(input.newCommitments.length),
    batchId: input.batchId,
    fillCount: input.newCommitments.length,
    marginChangeCommitments: [],
    marketId: input.marketId,
    matchTranscriptDigest: hashFields("external-match-transcript", [input.batchId]),
    newCommitments: input.newCommitments,
    openInterestDelta: BigInt(input.newCommitments.length),
    orderUpdates: input.orderUpdates,
    residualSize: 0n,
    settlementDigest: hashFields("external-settlement", [input.batchId]),
    spentNullifiers: input.spentNullifiers,
  };
  const publicInputHash = batchSettlementPublicInputHash({
    ...draft,
    proof: proof("batch-match"),
  });
  return {
    ...draft,
    proof: {
      ...proof("batch-match"),
      imageId: hashFields("risc0-image", [input.batchId]),
      journalDigest: publicInputHash,
      proofDigest: hashFields("risc0-seal", [input.batchId]),
      proofSystem: "risc0-groth16",
      publicInputHash,
      sealDigest: hashFields("risc0-seal", [input.batchId]),
    },
  };
}

function createProoflessMatcher(
  executor: ReturnType<typeof createExecutor>,
  config: ConstructorParameters<typeof MatcherService>[2] = {},
): MatcherService {
  return new MatcherService(executor.store, prooflessProofs(), config);
}

function prooflessProofs(): ConstructorParameters<typeof MatcherService>[1] {
  return {
    artifactFor() {
      return undefined;
    },
    createSettlement(input: SettlementProofInput): BatchSettlement {
      const draft = {
        aggregateVolume: input.match.aggregateVolume,
        batchId: input.batchId,
        fillCount: input.match.fills.length,
        marginChangeCommitments: input.match.marginChangeCommitments,
        marketId: input.market.marketId,
        matchTranscriptDigest: input.match.matchTranscriptDigest,
        newCommitments: input.match.fills.map((fill) => fill.positionCommitment),
        openInterestDelta: input.match.openInterestDelta,
        orderUpdates: input.match.orderUpdates,
        residualSize: input.match.residualSize,
        settlementDigest: hashFields("test-settlement", [input.batchId, input.match.matchTranscriptDigest]),
        spentNullifiers: input.match.spentNullifiers,
      };
      const publicInputHash = batchSettlementPublicInputHash({
        ...draft,
        proof: proof("batch-match"),
      });
      const sealDigest = hashFields("risc0-seal", [input.batchId, input.match.matchTranscriptDigest]);
      return {
        ...draft,
        proof: {
          ...proof("batch-match"),
          imageId: hashFields("risc0-image", [input.batchId]),
          journalDigest: publicInputHash,
          proofDigest: sealDigest,
          proofSystem: "risc0-groth16",
          publicInputHash,
          sealDigest,
        },
      };
    },
  } as never;
}

function externalBatchFixture(seed: string) {
  const executor = createExecutor();
  const market = {
    marketId: "btc-usd-perp",
    oraclePrice: 50_000n * PRICE_SCALE,
    maxLeverage: 10n,
    initialMarginRate: 100_000n,
    maintenanceMarginRate: 50_000n,
    fundingIndex: 0n,
  };
  executor.addMarket(market);
  const long = intentRecord(`${seed}-long`, market.marketId, executor.store.marginMembershipRoot());
  const short = intentRecord(`${seed}-short`, market.marketId, executor.store.marginMembershipRoot());
  executor.store.recordProof(long.proof);
  executor.store.recordProof(short.proof);
  executor.store.addIntent(long);
  executor.store.addIntent(short);
  const settlement = externalSettlement({
    batchId: `${seed}-batch`,
    marketId: market.marketId,
    newCommitments: [
      hashFields("position", [`${seed}-long`]),
      hashFields("position", [`${seed}-short`]),
    ],
    orderUpdates: [
      { intentCommitment: long.intentCommitment, status: "filled" as const },
      { intentCommitment: short.intentCommitment, status: "filled" as const },
    ],
    spentNullifiers: [long.noteNullifier, short.noteNullifier],
    store: executor.store,
  });
  const positionOpenings = [
    positionOpening(settlement, long, settlement.newCommitments[0]),
    positionOpening(settlement, short, settlement.newCommitments[1]),
  ];
  return {
    accountEvents: accountEventsForOpenings(positionOpenings),
    executor,
    positionOpenings,
    settlement,
  };
}

function rawP256PublicKey(): string {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
}

function accountEventsForOpenings(openings: ReturnType<typeof positionOpening>[]) {
  return openings.map(accountEventForOpening);
}

function accountEventForOpening(opening: ReturnType<typeof positionOpening>) {
  const ciphertext = `base64:encrypted-position:${opening.positionCommitment.slice(2)}`;
  const dataCommitment = positionOpeningAccountEventDataCommitment(opening, ciphertext);
  return {
    ciphertext,
    createdAt: opening.openedAt,
    dataCommitment,
    eventId: positionOpeningAccountEventId(opening, dataCommitment),
    ownerCommitment: opening.ownerCommitment,
  };
}

function positionOpening(
  settlement: BatchSettlement,
  source: IntentRecord,
  positionCommitment: Hex,
) {
  const now = Date.now();
  return {
    batchId: settlement.batchId,
    marketId: settlement.marketId,
    openedAt: now,
    ownerCommitment: source.ownerCommitment,
    positionCommitment,
    positionNullifier: hashFields("position-nullifier", [positionCommitment]),
    settlementDigest: settlement.settlementDigest,
    sourceIntentCommitment: source.intentCommitment,
    status: "open" as const,
    updatedAt: now,
  };
}

function depositProofRecord(amount: bigint, commitment: `0x${string}`) {
  return {
    amount,
    commitment,
    tokenDigest: hashFields("token-digest", ["asset-deposit"]),
    proof: proof("deposit-note"),
  };
}

function createFileExecutor(storePath: string): ExecutorService {
  return new ExecutorService({}, new FileProtocolStore(storePath));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
