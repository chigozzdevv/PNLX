import { describe, expect, test } from "bun:test";
import {
  commitIntent,
  digestToFieldHex,
  hashFields,
  intentBindingFields,
  intentOwnerCommitmentField,
} from "@merkl/crypto";
import { createECDH, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRICE_SCALE } from "@merkl/market-math";
import type {
  BatchSettlement,
  Hex,
  IntentRecord,
  IntentValidityRecord,
  TradeIntent,
} from "@merkl/protocol-types";
import { loadEnv } from "../../server/src/config/env";
import { BatchesService } from "../../server/src/features/batches/batches.service";
import { encodeStellarPublicKey } from "../../server/src/features/auth/auth.service";
import { IntentsService } from "../../server/src/features/intents/intents.service";
import { MarketsService } from "../../server/src/features/markets/markets.service";
import { NotesService } from "../../server/src/features/notes/notes.service";
import { OrdersService } from "../../server/src/features/orders/orders.service";
import { batchSettlementPublicInputHash } from "../../server/src/shared/protocol/batch-settlement-proof";
import {
  positionOpeningAccountEventDataCommitment,
  positionOpeningAccountEventId,
} from "../../server/src/shared/protocol/account-event-binding";
import { externalMatcherTranscriptHash } from "../../server/src/shared/protocol/external-matcher-transcript";
import { matcherAttestationMessage } from "../../server/src/shared/protocol/matcher-attestation";
import { ProtocolStore } from "../../server/src/shared/state/store";
import { createBatchExecutor } from "../../server/src/workers/batch-executor/batch-executor.worker";
import { createExecutor } from "../../server/src/workers/executor/executor.worker";
import { createMatcherApp } from "../../server/src/workers/matcher/matcher.app";
import { NilccBlindComputeClient } from "../../server/src/workers/matcher/nilcc/matcher.service";
import { RemoteBlindComputeClient } from "../../server/src/workers/matcher/remote-compute/matcher.service";
import { RemoteMatcherClient } from "../../server/src/workers/matcher/remote/matcher.service";
import { createMatcher } from "../../server/src/workers/matcher/matcher.worker";
import { createFundingEngine } from "../../server/src/workers/funding-engine/funding-engine.worker";
import { createIndexer } from "../../server/src/workers/indexer/indexer.worker";
import { createOnchainRelay } from "../../server/src/workers/onchain/onchain.worker";
import { OracleService } from "../../server/src/workers/oracle/oracle.service";
import { createRelayer } from "../../server/src/workers/relayer/relayer.worker";

describe("support workers", () => {
  test("defaults production oracle authority to on-chain market pricing", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRequired = process.env.ORACLE_ONCHAIN_REQUIRED;
    const previousSource = process.env.ORACLE_PRICE_SOURCE;
    process.env.NODE_ENV = "production";
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
    }
  });

  test("preserves oracle publisher aliases while normalizing publisher addresses", () => {
    const previousSources = process.env.ORACLE_PUBLISHER_SOURCES;
    const previousAddresses = process.env.ORACLE_PUBLISHER_ADDRESSES;
    process.env.ORACLE_PUBLISHER_SOURCES = "merkl-oracle-1,OracleTwo";
    process.env.ORACLE_PUBLISHER_ADDRESSES = "gpublishera,gpublisherb";

    try {
      const env = loadEnv();
      expect(env.oraclePublisherSources).toEqual(["merkl-oracle-1", "OracleTwo"]);
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
      process.env.EXTERNAL_MATCHER_URL = "https://legacy-matcher.merkl.local";
      process.env.EXTERNAL_MATCHER_TOKEN = "legacy-token";
      const legacyEnv = loadEnv();
      expect(legacyEnv.matcherServiceUrl).toBe("https://legacy-matcher.merkl.local");
      expect(legacyEnv.matcherServiceToken).toBe("legacy-token");

      process.env.MATCHER_SERVICE_URL = "https://matcher.merkl.local";
      process.env.MATCHER_SERVICE_TOKEN = "service-token";
      const preferredEnv = loadEnv();
      expect(preferredEnv.matcherServiceUrl).toBe("https://matcher.merkl.local");
      expect(preferredEnv.matcherServiceToken).toBe("service-token");
    } finally {
      restoreEnv("MATCHER_SERVICE_URL", previousServiceUrl);
      restoreEnv("MATCHER_SERVICE_TOKEN", previousServiceToken);
      restoreEnv("EXTERNAL_MATCHER_URL", previousLegacyUrl);
      restoreEnv("EXTERNAL_MATCHER_TOKEN", previousLegacyToken);
    }
  });

  test("parses nilCC blind compute provider configuration", () => {
    const previousBackend = process.env.MATCHER_COMPUTE_BACKEND;
    const previousWorkload = process.env.NILCC_WORKLOAD_URL;
    const previousContains = process.env.NILCC_ATTESTATION_CONTAINS;
    const previousHash = process.env.NILCC_ATTESTATION_REPORT_SHA256;
    process.env.MATCHER_COMPUTE_BACKEND = "nilcc";
    process.env.NILCC_WORKLOAD_URL = "https://nilcc.merkl.local";
    process.env.NILCC_ATTESTATION_CONTAINS = "merkl-blind-compute-v1,sev-snp";
    process.env.NILCC_ATTESTATION_REPORT_SHA256 = "0xabc123";

    try {
      const env = loadEnv();
      expect(env.matcherComputeBackend).toBe("nilcc");
      expect(env.nilccWorkloadUrl).toBe("https://nilcc.merkl.local");
      expect(env.nilccAttestationContains).toEqual(["merkl-blind-compute-v1", "sev-snp"]);
      expect(env.nilccAttestationReportSha256).toBe("0xabc123");
    } finally {
      restoreEnv("MATCHER_COMPUTE_BACKEND", previousBackend);
      restoreEnv("NILCC_WORKLOAD_URL", previousWorkload);
      restoreEnv("NILCC_ATTESTATION_CONTAINS", previousContains);
      restoreEnv("NILCC_ATTESTATION_REPORT_SHA256", previousHash);
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

  test("persists relay history across relayer restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "merkl-relays-"));
    const historyPath = join(dir, "relay-state.json");
    const first = createRelayer({ historyPath });
    const commitment = hashFields("note", ["persistent-relay"]);

    const tx = first.relay({ kind: "deposit", payload: { commitment } });
    const second = createRelayer({ historyPath });

    expect(second.list()).toHaveLength(1);
    expect(second.list()[0].relayId).toBe(tx.relayId);
    expect(second.list()[0].payloadDigest).toBe(tx.payloadDigest);
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
    const dir = mkdtempSync(join(tmpdir(), "merkl-store-"));
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

    const first = createExecutor({ storePath });
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

    const second = createExecutor({ storePath });

    expect(second.store.markets.get(market.marketId)?.oraclePrice).toBe(market.oraclePrice);
    expect(second.store.marginCommitments.has(commitment)).toBe(true);
    expect(second.store.hasProof(proof)).toBe(true);
    expect(second.store.pendingAssetDeposits.get(pendingCommitment)?.amount).toBe(1_000n);
  });

  test("rejects threshold recovery when private matching is required", () => {
    expect(() =>
      createExecutor({
        matchingBackend: "threshold-recovery",
        privateMatchingRequired: true,
      }),
    ).toThrow("private matching requires MATCHING_BACKEND=external-blind");
  });

  test("commits externally proven blind settlement transcripts without recovering shares", () => {
    const executor = createExecutor({ matchingBackend: "external-blind" });
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
    ).toThrow("external blind matching requires an externally proven settlement transcript");

    const settlement = externalSettlement({
      batchId: "external-batch",
      marketId: market.marketId,
      oldRoot: executor.store.positionMembershipRoot(),
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

  test("indexes external settlements after a submitted verifier relay", () => {
    const executor = createExecutor({ matchingBackend: "external-blind" });
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
      oldRoot: executor.store.positionMembershipRoot(),
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
    const result = service.commitExternal({
      accountEvents: accountEventsForOpenings(positionOpenings),
      settlement,
      positionOpenings,
    });

    expect(result.settlementDigest).toBe(settlement.settlementDigest);
    expect(executor.store.hasProof(settlement.proof)).toBe(true);
    expect(executor.store.positionLifecycle.size).toBe(2);
    expect(executor.store.accountEvents.size).toBe(2);
  });

  test("requires authorized matcher committee attestation for external blind settlements", () => {
    const fixture = externalBatchFixture("matcher-attestation-required");
    const signer = matcherSigner();
    fixture.executor.store.recordProof(fixture.settlement.proof);
    const service = new BatchesService(
      fixture.executor,
      undefined,
      [],
      false,
      {
        matcherCommitteeAddresses: [signer.address],
        matcherCommitteeRequired: true,
        matcherCommitteeThreshold: 1,
      },
    );

    expect(() =>
      service.commitExternal({
        accountEvents: fixture.accountEvents,
        settlement: fixture.settlement,
        positionOpenings: fixture.positionOpenings,
      }),
    ).toThrow("external matcher attestation is required");
    expect(fixture.executor.store.settlements.size).toBe(0);
  });

  test("accepts external blind settlements attested by matcher committee quorum", () => {
    const fixture = externalBatchFixture("matcher-attestation-ok");
    const signerA = matcherSigner();
    const signerB = matcherSigner();
    const outsider = matcherSigner();
    fixture.executor.store.recordProof(fixture.settlement.proof);
    const service = new BatchesService(
      fixture.executor,
      undefined,
      [],
      false,
      {
        matcherCommitteeAddresses: [signerA.address, signerB.address],
        matcherCommitteeRequired: true,
        matcherCommitteeThreshold: 2,
      },
    );

    expect(() =>
      service.commitExternal({
        accountEvents: fixture.accountEvents,
        attestation: matcherAttestation(fixture, [signerA, outsider]),
        settlement: fixture.settlement,
        positionOpenings: fixture.positionOpenings,
      }),
    ).toThrow("external matcher attestation threshold not met");

    const result = service.commitExternal({
      accountEvents: fixture.accountEvents,
      attestation: matcherAttestation(fixture, [signerA, signerB]),
      settlement: fixture.settlement,
      positionOpenings: fixture.positionOpenings,
    });

    expect(result.settlementDigest).toBe(fixture.settlement.settlementDigest);
    expect(fixture.executor.store.positionLifecycle.size).toBe(2);
  });

  test("accepts worker-produced external matcher transcripts through attested batch ingestion", () => {
    const executor = createExecutor({ matchingBackend: "external-blind" });
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    const signer = matcherSigner();
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
    const matcher = createMatcher(executor, {
      accountEventEncryptor: (payload) => `base64:test-encrypted:${payload.kind}`,
      signers: [
        {
          address: signer.address,
          sign: (message) => sign(null, Buffer.from(message), signer.keyPair.privateKey).toString("base64"),
        },
      ],
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
      {
        matcherCommitteeAddresses: [signer.address],
        matcherCommitteeRequired: true,
        matcherCommitteeThreshold: 1,
      },
    );

    const transcript = matcher.createSettlementTranscript({
      batchId: "worker-produced-batch",
      marketId: market.marketId,
    });
    const result = service.commitExternal(transcript);

    expect(transcript.attestation?.transcriptHash).toBe(externalMatcherTranscriptHash(transcript));
    expect(result.settlementDigest).toBe(transcript.settlement.settlementDigest);
    expect(result.aggregateVolume).toBe(2n);
    expect(executor.store.positionLifecycle.size).toBe(2);
    expect(executor.store.accountEvents.size).toBe(2);
    expect([...executor.store.orderLifecycle.values()].every((order) => order.status === "filled")).toBe(true);
  });

  test("worker-produced external matcher transcripts encrypt owner events to registered account keys", () => {
    const executor = createExecutor({ matchingBackend: "external-blind" });
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 9n,
    };
    const signer = matcherSigner();
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
    const matcher = createMatcher(executor, {
      signers: [
        {
          address: signer.address,
          sign: (message) => sign(null, Buffer.from(message), signer.keyPair.privateKey).toString("base64"),
        },
      ],
    });

    const transcript = matcher.createSettlementTranscript({
      batchId: "encrypted-worker-batch",
      marketId: market.marketId,
    });

    expect(transcript.accountEvents).toHaveLength(2);
    expect(transcript.accountEvents.every((event) =>
      event.ciphertext.startsWith("merkl-account-event-v1:")
    )).toBe(true);
    expect(JSON.stringify(transcript.accountEvents)).not.toContain("positionNullifier");
    expect(transcript.attestation?.transcriptHash).toBe(externalMatcherTranscriptHash(transcript));
  });

  test("remote matcher client requests a separate matcher service", async () => {
    const fixture = externalBatchFixture("remote-matcher-client");
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://matcher.merkl.local/match/settlement");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer remote-secret");
      return new Response(body({
        accountEvents: fixture.accountEvents,
        positionOpenings: fixture.positionOpenings,
        residualOrders: [],
        settlement: fixture.settlement,
      }), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    try {
      const client = new RemoteMatcherClient({
        token: "remote-secret",
        url: "https://matcher.merkl.local",
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

  test("remote blind compute client requests a separate compute backend", async () => {
    const fixture = externalBatchFixture("remote-blind-compute-client");
    const computeTranscript = committeeTranscript(fixture);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://compute.merkl.local/compute/settlement");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer compute-secret");
      const requestBody = JSON.parse(String(init?.body));
      expect(requestBody.market.oraclePrice).toBe((50_000n * PRICE_SCALE).toString());
      return new Response(body(computeTranscript), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    try {
      const client = new RemoteBlindComputeClient({
        token: "compute-secret",
        url: "https://compute.merkl.local",
      });
      const transcript = await client.createSettlementTranscript({
        batchId: fixture.settlement.batchId,
        market: fixture.executor.store.markets.get(fixture.settlement.marketId)!,
        oldRoot: fixture.executor.store.positionMembershipRoot(),
        positionCommitments: [],
        records: [],
        residuals: [],
      }, {} as never);

      expect(transcript.settlement.settlementDigest).toBe(fixture.settlement.settlementDigest);
      expect(transcript.positionEvents).toHaveLength(2);
      expect(transcript.positionEvents[0].margin).toBe(10_000n);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("nilCC blind compute client verifies workload attestation before compute", async () => {
    const fixture = externalBatchFixture("nilcc-blind-compute-client");
    const computeTranscript = committeeTranscript(fixture);
    const calls: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      calls.push(String(url));
      if (String(url) === "https://nilcc.merkl.local/nilcc/api/v2/report") {
        expect(init?.method).toBe("GET");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer attest-secret");
        return new Response("measurement:merkl-blind-compute-v1", { status: 200 });
      }

      expect(String(url)).toBe("https://nilcc.merkl.local/compute/settlement");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer compute-secret");
      return new Response(body(computeTranscript), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    try {
      const client = new NilccBlindComputeClient({
        attestationContains: ["merkl-blind-compute-v1"],
        attestationRequired: true,
        attestationToken: "attest-secret",
        token: "compute-secret",
        workloadUrl: "https://nilcc.merkl.local",
      });
      const transcript = await client.createSettlementTranscript({
        batchId: fixture.settlement.batchId,
        market: fixture.executor.store.markets.get(fixture.settlement.marketId)!,
        oldRoot: fixture.executor.store.positionMembershipRoot(),
        positionCommitments: [],
        records: [],
        residuals: [],
      }, {} as never);

      expect(transcript.settlement.settlementDigest).toBe(fixture.settlement.settlementDigest);
      expect(calls).toEqual([
        "https://nilcc.merkl.local/nilcc/api/v2/report",
        "https://nilcc.merkl.local/compute/settlement",
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("nilCC blind compute client rejects unpinned attestations", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("measurement:other-workload", { status: 200 })) as typeof fetch;

    try {
      const client = new NilccBlindComputeClient({
        attestationContains: ["merkl-blind-compute-v1"],
        attestationRequired: true,
        workloadUrl: "https://nilcc.merkl.local",
      });

      await expect(client.createSettlementTranscript({} as never, {} as never)).rejects.toThrow(
        "nilCC attestation report does not match pinned workload identity",
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("private matcher app requires remote or nilCC blind compute backend", () => {
    expect(() =>
      createMatcherApp({
        computeBackend: "local-threshold",
        privateMatchingRequired: true,
      }),
    ).toThrow("MATCHER_COMPUTE_BACKEND=remote-blind or nilcc is required for private matcher service");

    expect(() =>
      createMatcherApp({
        computeBackend: "remote-blind",
        privateMatchingRequired: true,
      }),
    ).toThrow("MATCHER_COMPUTE_URL is required for remote blind matcher compute");

    expect(() =>
      createMatcherApp({
        computeBackend: "nilcc",
        privateMatchingRequired: true,
      }),
    ).toThrow("NILCC_WORKLOAD_URL is required for nilCC blind compute");

    expect(() =>
      createMatcherApp({
        computeBackend: "nilcc",
        nilccWorkloadUrl: "https://nilcc.merkl.local",
        privateMatchingRequired: true,
      }),
    ).toThrow("NILCC_ATTESTATION_REPORT_SHA256 or NILCC_ATTESTATION_CONTAINS is required for nilCC blind compute");
  });

  test("matcher app produces transcripts from a separate persisted matcher process view", async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "merkl-remote-matcher-")), "protocol-store.json");
    const executor = createExecutor({ matchingBackend: "external-blind", storePath });
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
      thresholdShareNodeIds: ["node-a", "node-b", "node-c"],
      thresholdShareThreshold: 2,
      storePath,
      token: "matcher-token",
    });
    const response = await matcherApp.handle(
      new Request("http://matcher.local/match/settlement", {
        body: body({
          batchId: "remote-app-batch",
          marketId: market.marketId,
        }),
        headers: {
          authorization: "Bearer matcher-token",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(201);
    const transcript = (await response.json()) as Record<string, unknown>;
    expect((transcript.accountEvents as unknown[])).toHaveLength(2);
    expect(JSON.stringify(transcript.accountEvents)).not.toContain("positionNullifier");
  });

  test("private matcher app delegates settlement compute to remote blind backend", async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "merkl-remote-compute-")), "protocol-store.json");
    const executor = createExecutor({ matchingBackend: "external-blind", storePath });
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 10n,
      initialMarginRate: 100_000n,
      maintenanceMarginRate: 50_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);
    const long = intentRecord("remote-compute-long", market.marketId, executor.store.marginMembershipRoot());
    const short = intentRecord("remote-compute-short", market.marketId, executor.store.marginMembershipRoot());
    executor.store.recordProof(long.proof);
    executor.store.recordProof(short.proof);
    executor.store.addIntent(long);
    executor.store.addIntent(short);
    for (const record of [long, short]) {
      executor.store.upsertAccountEncryptionKey({
        algorithm: "ecdh-p256-aes-gcm",
        createdAt: 1,
        ownerCommitment: record.ownerCommitment,
        publicKey: rawP256PublicKey(),
        updatedAt: 1,
      });
    }
    const settlement = externalSettlement({
      batchId: "remote-compute-batch",
      marketId: market.marketId,
      oldRoot: executor.store.positionMembershipRoot(),
      newCommitments: [
        hashFields("position", ["remote-compute-long"]),
        hashFields("position", ["remote-compute-short"]),
      ],
      orderUpdates: [
        { intentCommitment: long.intentCommitment, status: "filled" as const },
        { intentCommitment: short.intentCommitment, status: "filled" as const },
      ],
      spentNullifiers: [long.noteNullifier, short.noteNullifier],
      store: executor.store,
    });
    const computeTranscript = committeeTranscript({
      executor,
      positionOpenings: [
        positionOpening(settlement, long, settlement.newCommitments[0]),
        positionOpening(settlement, short, settlement.newCommitments[1]),
      ],
      settlement,
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      expect(String(url)).toBe("https://compute.merkl.local/compute/settlement");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer compute-token");
      const requestBody = JSON.parse(String(init?.body));
      expect(requestBody.records).toHaveLength(2);
      return new Response(body(computeTranscript), {
        headers: { "content-type": "application/json" },
        status: 201,
      });
    }) as typeof fetch;

    try {
      const matcherApp = createMatcherApp({
        computeBackend: "remote-blind",
        computeToken: "compute-token",
        computeUrl: "https://compute.merkl.local",
        privateMatchingRequired: true,
        storePath,
        token: "matcher-token",
      });
      const response = await matcherApp.handle(
        new Request("http://matcher.local/match/settlement", {
          body: body({
            batchId: "remote-compute-batch",
            marketId: market.marketId,
          }),
          headers: {
            authorization: "Bearer matcher-token",
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(201);
      const transcript = (await response.json()) as Record<string, unknown>;
      expect((transcript.accountEvents as unknown[])).toHaveLength(2);
      expect(JSON.stringify(transcript.accountEvents)).not.toContain("positionNullifier");
      expect((transcript.settlement as Record<string, unknown>).settlementDigest).toBe(settlement.settlementDigest);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("batch executor automatically settles crossed private orders through matcher service", async () => {
    const executor = createExecutor({ matchingBackend: "external-blind" });
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
      batchId: "batch-executor-input",
      limitPrice: 50_500n * PRICE_SCALE,
      marketId: market.marketId,
    }));
    const short = submitBackedIntent(executor, matchedTradeIntent("batch-executor-short", "short", {
      batchId: "batch-executor-input",
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
    const matcher = createMatcher(executor);
    const batchExecutor = createBatchExecutor(
      executor,
      matcher,
      {
        batchIdPrefix: "runner",
        intervalMs: 1000,
        settlementsOnchainRequired: true,
      },
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
    );

    const result = await batchExecutor.runOnce({ now: 1234 });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].record.status).toBe("settled");
    expect(result.results[0].record.batchId).toBe("runner-btc-usd-perp-1234");
    expect(result.results[0].record.fillCount).toBe(2);
    expect(executor.store.settlements.size).toBe(1);
    expect(executor.store.batchExecutionRuns.size).toBe(1);
    expect(executor.store.accountEvents.size).toBe(2);
    expect(executor.store.orderLifecycle.get(long.intentCommitment)?.status).toBe("filled");
    expect(executor.store.orderLifecycle.get(short.intentCommitment)?.status).toBe("filled");
  });

  test("batch executor records skipped runs without mutating settlement state", async () => {
    const executor = createExecutor({ matchingBackend: "external-blind" });
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
      batchId: "batch-executor-skip-input",
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
      createMatcher(executor),
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

  test("rejects external matcher attestations when indexed transcript is tampered", () => {
    const fixture = externalBatchFixture("matcher-attestation-tamper");
    const signer = matcherSigner();
    fixture.executor.store.recordProof(fixture.settlement.proof);
    const service = new BatchesService(
      fixture.executor,
      undefined,
      [],
      false,
      {
        matcherCommitteeAddresses: [signer.address],
        matcherCommitteeRequired: true,
        matcherCommitteeThreshold: 1,
      },
    );
    const tamperedOpenings = [
      { ...fixture.positionOpenings[0], openedAt: fixture.positionOpenings[0].openedAt + 1 },
      fixture.positionOpenings[1],
    ];

    expect(() =>
      service.commitExternal({
        accountEvents: fixture.accountEvents,
        attestation: matcherAttestation(fixture, [signer]),
        settlement: fixture.settlement,
        positionOpenings: tamperedOpenings,
      }),
    ).toThrow("external matcher attestation transcript mismatch");
    expect(fixture.executor.store.settlements.size).toBe(0);
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
    expect(uncapped.results[0].update?.newFundingIndex).toBe(8n);

    const negative = engine.runOnce({
      appliedAt: 3_000,
      elapsedMs: 60 * 60 * 1000,
      marketId: market.marketId,
      maxFundingDelta: 2n,
      premiumRate: -100n,
    });

    expect(negative.results[0].update?.fundingDelta).toBe(-2n);
    expect(negative.results[0].update?.oldFundingIndex).toBe(8n);
    expect(negative.results[0].update?.newFundingIndex).toBe(6n);
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
    expect(proofInput?.newFundingIndex).toBe(9n);
    expect(proofInput?.markPrice).toBe(50_000n * PRICE_SCALE);
    expect(proofInput?.maxFundingDelta).toBe(10n);
    expect(relayed?.proof).toBe(fundingProof);
    expect(executor.store.markets.get(market.marketId)?.fundingIndex).toBe(9n);
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
        source: "merkl-testnet",
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
      "merkl-testnet",
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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

    const tx = relayer.submitSignedXdr({ xdr: "AAAA" });

    expect(calls[0]).toEqual(["stellar", "tx", "send", "AAAA", "--network", "testnet"]);
    expect(tx.kind).toBe("signed-xdr");
    expect(tx.functionName).toBe("tx send");
    expect(tx.submitted).toBe(true);
    expect(tx.txHash).toBe("0xabc99900abc99900abc99900abc99900abc99900abc99900abc99900abc99900");
  });

  test("retries transient stellar cli sequence failures", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
      shareCommitment: hashFields("shares", ["intent-relay"]),
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
    expect(calls[0]).toContain(record.shareCommitment.slice(2));
    expect(calls[1]).toContain("intent-registry-contract");
    expect(calls[1]).toContain("cancel");
    expect(calls[1]).toContain(record.intentCommitment.slice(2));
  });

  test("prepares wallet-signed stellar cli invocations", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
    const deployment = {
      contracts: {
        "conditional-order": "conditional-order-contract",
        "position-close": "position-close-contract",
      },
      network: "testnet",
      source: "merkl-testnet",
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
      newPositionRoot: hashFields("new-position-root", ["worker-onchain"]),
      marginOutputCommitment: hashFields("margin-output", ["worker-onchain"]),
      proof: positionProof,
    });

    expect(calls.map((call) => call[2])).toEqual([
      "invoke",
      "invoke",
      "invoke",
      "invoke",
      "invoke",
    ]);
    expect(calls[0]).toContain("conditional-order-contract");
    expect(calls[0]).toContain("register");
    expect(calls[1]).toContain("conditional-close-verifier");
    expect(calls[1]).toContain("verify_and_record");
    expect(calls[2]).toContain("conditional-order-contract");
    expect(calls[2]).toContain("trigger");
    expect(calls[2]).toContain((56_000n * PRICE_SCALE).toString());
    expect(calls[3]).toContain("position-close-verifier");
    expect(calls[3]).toContain("verify_and_record");
    expect(calls[4]).toContain("position-close-contract");
    expect(calls[4]).toContain("settle");
    expect(calls[4]).toContain(hashFields("market-id", [marketId]).slice(2));
    expect(calls[4]).toContain(hashFields("position-root", ["worker-onchain"]).slice(2));
    expect(calls[4]).toContain(hashFields("position", ["worker-onchain"]).slice(2));
    expect(calls[4]).toContain(nullifier.slice(2));
    expect(calls[4]).toContain(hashFields("new-position-root", ["worker-onchain"]).slice(2));
    expect(calls[4]).toContain((56_000n * PRICE_SCALE).toString());
  });

  test("builds domain on-chain relays for manual position close settlement", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "merkl-testnet",
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
          "position-close": "position-close-contract",
        },
        network: "testnet",
        source: "merkl-testnet",
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
      newPositionRoot: hashFields("new-position-root", ["worker-manual-close"]),
      marginOutputCommitment: hashFields("margin-output", ["worker-manual-close"]),
      proof: proof("position-close"),
    });

    expect(calls.map((call) => call[2])).toEqual(["invoke", "invoke"]);
    expect(calls[0]).toContain("position-close-verifier");
    expect(calls[0]).toContain("verify_and_record");
    expect(calls[1]).toContain("position-close-contract");
    expect(calls[1]).toContain("settle_manual");
    expect(calls[1]).toContain(hashFields("market-id", [marketId]).slice(2));
    expect(calls[1]).toContain(nullifier.slice(2));
    expect(calls[1]).toContain((56_000n * PRICE_SCALE).toString());
  });

  test("builds domain on-chain relays for batch settlement", () => {
    const calls: string[][] = [];
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "merkl-testnet",
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
        source: "merkl-testnet",
        sourceAddress: "GTEST",
        verifiers: {
          "batch-match-proof-verifier": "batch-match-verifier",
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
    const batchProof = proof("batch-match");

    onchain.settleBatch({
      batchId,
      marketId,
      oldRoot: hashFields("old-root", [batchId]),
      newRoot: hashFields("new-root", [batchId]),
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
    expect(calls[0]).toContain("batch-match-verifier");
    expect(calls[0]).toContain("verify_and_record");
    expect(calls[0]).toContain(`/tmp/batch-match/public_inputs`);
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
      source: "merkl-reader",
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
      "merkl-reader",
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
    const dir = mkdtempSync(join(tmpdir(), "merkl-market-update-"));
    const storePath = join(dir, "protocol-store.json");
    const executor = createExecutor({ storePath });
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
    const reloaded = createExecutor({ storePath });

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
        source: "merkl-testnet",
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
        source: "merkl-admin",
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
        source: "merkl-admin",
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
        source: "merkl-admin",
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
        source: "merkl-admin",
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
    expect(prepared.xdr).toBe("facefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeed");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("--build-only");
    expect(calls[0]).toContain("deposit_asset");
    expect(calls[1]).toContain("deposit-note-verifier-contract");
    expect(calls[1]).toContain("verify_and_record");
    expect(calls[2]).toContain("shielded-pool-contract");
    expect(calls[2]).toContain("deposit_asset");
    expect(calls[2]).toContain("--source");
    expect(calls[2]).toContain("trader-alias");
    expect(calls[2]).toContain("--token");
    expect(calls[2]).toContain("usdc-token-contract");
    expect(calls[2]).toContain("--amount");
    expect(calls[2]).toContain("25000000");
    expect(calls[2]).toContain(commitment.slice(2));
    expect(calls[2]).toContain("--proof");
  });

  test("asset-backed deposit relay credits private margin membership", () => {
    const relayer = createRelayer({
      config: {
        mode: "stellar-cli",
        network: "testnet",
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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

    expect(events).toEqual(["prove", `verify:${depositProof.proof.proofDigest}`, "prepare"]);
    expect(result.depositProof).toBe(depositProof);
    expect(result.proofVerification.relays[0].functionName).toBe("verify_and_record");
    expect(result.proofVerification.relays[0].submitted).toBe(true);
    expect(result.action.functionName).toBe("deposit_asset");
    expect(result.pendingDeposit.commitment).toBe(commitment);
    expect(result.pendingDeposit.preparedXdrDigest).toBe(
      hashFields("prepared-asset-deposit-xdr", ["assetpreparedxdr"]),
    );
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
        source: "merkl-testnet",
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
    margin: 1_000n,
    marketId,
    noteNullifier: hashFields("note-nullifier", [seed]),
    owner: `G${seed.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(55, "A").slice(0, 55)}`,
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
    owner: `G${seed.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(55, "A").slice(0, 55)}`,
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

function intentRecord(seed: string, marketId: string, marginRoot: Hex): IntentRecord {
  const intentCommitment = hashFields("intent", [seed]);
  return {
    batchDigest: hashFields("batch-digest", [seed]),
    batchId: "external-batch",
    intentCommitment,
    marketDigest: hashFields("market-digest", [marketId]),
    marketId,
    marginRoot,
    noteNullifier: hashFields("note-nullifier", [seed]),
    ownerCommitment: hashFields("owner", [seed]),
    ownerCommitmentField: hashFields("owner-field", [seed]),
    proof: proof("intent-validity"),
    shareCommitment: hashFields("share-commitment", [seed]),
  };
}

function externalSettlement(input: {
  batchId: string;
  marketId: string;
  newCommitments: Hex[];
  oldRoot: Hex;
  orderUpdates: BatchSettlement["orderUpdates"];
  spentNullifiers: Hex[];
  store: ProtocolStore;
}): BatchSettlement {
  const settlement: BatchSettlement = {
    aggregateVolume: BigInt(input.newCommitments.length),
    batchId: input.batchId,
    fillCount: input.newCommitments.length,
    marginChangeCommitments: [],
    marketId: input.marketId,
    matchTranscriptDigest: hashFields("external-match-transcript", [input.batchId]),
    newCommitments: input.newCommitments,
    newRoot: input.store.positionMembershipRootWithMany(input.newCommitments),
    oldRoot: input.oldRoot,
    openInterestDelta: BigInt(input.newCommitments.length),
    orderUpdates: input.orderUpdates,
    proof: proof("batch-match"),
    residualSize: 0n,
    settlementDigest: hashFields("external-settlement", [input.batchId]),
    spentNullifiers: input.spentNullifiers,
  };
  settlement.proof.publicInputHash = batchSettlementPublicInputHash(settlement);
  return settlement;
}

function externalBatchFixture(seed: string) {
  const executor = createExecutor({ matchingBackend: "external-blind" });
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
    oldRoot: executor.store.positionMembershipRoot(),
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

function committeeTranscript(fixture: {
  positionOpenings: ReturnType<typeof positionOpening>[];
  settlement: BatchSettlement;
}) {
  return {
    positionEvents: fixture.positionOpenings.map((opening, index) => ({
      entryPrice: 50_000n * PRICE_SCALE,
      fundingIndex: 0n,
      margin: 10_000n,
      marketId: opening.marketId,
      positionCommitment: opening.positionCommitment,
      positionNullifier: opening.positionNullifier,
      side: index === 0 ? "long" as const : "short" as const,
      size: 1n,
      sourceIntentCommitment: opening.sourceIntentCommitment,
    })),
    positionOpenings: fixture.positionOpenings,
    residualOrders: [],
    settlement: fixture.settlement,
  };
}

function matcherSigner() {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  return {
    address: encodeStellarPublicKey(Buffer.from(publicKeyDer).subarray(-32)),
    keyPair,
  };
}

function rawP256PublicKey(): string {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
}

function matcherAttestation(transcript: {
  accountEvents: ReturnType<typeof accountEventForOpening>[];
  positionOpenings: ReturnType<typeof positionOpening>[];
  residualOrders?: [];
  settlement: BatchSettlement;
}, signers: ReturnType<typeof matcherSigner>[]) {
  const { settlement } = transcript;
  const publicInputHash = batchSettlementPublicInputHash(settlement);
  const transcriptHash = externalMatcherTranscriptHash(transcript);
  const message = matcherAttestationMessage(transcript, publicInputHash, transcriptHash);
  return {
    publicInputHash,
    settlementDigest: settlement.settlementDigest,
    signatures: signers.map((signer) => ({
      signer: signer.address,
      signature: sign(null, Buffer.from(message), signer.keyPair.privateKey).toString("base64"),
    })),
    transcriptHash,
  };
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
