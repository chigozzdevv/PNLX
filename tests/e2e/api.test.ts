import { describe, expect, test } from "bun:test";
import {
  circuitDisclosureCommitment,
  commitConditionalOrder,
  commitIntent,
  type FieldMerkleProof,
  fieldMerkleProof,
  fieldMerkleRoot,
  hashFields,
  ownerCommitment,
} from "@pnlx/crypto";
import { PRICE_SCALE, settleClose } from "@pnlx/market-math";
import { circuitKey } from "@pnlx/proof-system";
import type { BatchSettlement, Hex, ProofMeta, TradeIntent } from "@pnlx/protocol-types";
import { createCircuitMarginNote, createCircuitPositionNote } from "@pnlx/sdk";
import { createECDH, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createAppRuntime } from "@/app";
import { encodeStellarPublicKey, stellarSignedMessageHash } from "@/features/auth/auth.service";
import { createMatcherApp } from "@/workers/matcher/matcher.app";
import { MatcherService } from "@/workers/matcher/matcher.service";
import { createExecutor } from "@/workers/executor/executor.worker";
import { ExecutorService } from "@/workers/executor/executor.service";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";
import { ProverService } from "@/workers/prover/prover.service";
import type { SettlementProofInput } from "@/workers/proof-coordinator/proof-coordinator.model";
import {
  RISC0_BATCH_MATCH_CIRCUIT_KEY,
  RISC0_STELLAR_VERIFIER_HASH,
} from "@/workers/risc0-matcher/risc0-proof";

process.env.ASSET_CUSTODY_REQUIRED = "false";
process.env.AUTH_REQUIRED = "false";
process.env.COLLATERAL_TOKEN_CONTRACT = "";
process.env.COLLATERAL_TOKEN_DIGEST = "";
process.env.FUNDING_ENGINE_ENABLED = "false";
process.env.MATCHER_PROVIDER = "risc0";
process.env.PRIVATE_MATCHING_REQUIRED = "false";
process.env.SERVER_WITNESS_ROUTES_ENABLED = "true";
process.env.STELLAR_ONCHAIN_RELAY = "false";
process.env.STELLAR_RELAYER_MODE = "local";

type CircuitMarginNote = ReturnType<typeof createCircuitMarginNote>;
type MarginMembershipProof = Pick<FieldMerkleProof, "indices" | "root" | "siblings">;
type TestKeyPair = {
  privateKey: KeyObject;
  publicKey: KeyObject;
};

function body(data: unknown): BodyInit {
  return JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

function rawP256PublicKey(): string {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
}

async function call(path: string, data?: unknown): Promise<Record<string, unknown>> {
  const app = createApp();
  const response = await app.handle(
    new Request(`http://pnlx.local${path}`, {
      method: data ? "POST" : "GET",
      body: data ? body(data) : undefined,
      headers: data ? { "content-type": "application/json" } : undefined,
    }),
  );
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as Record<string, unknown>;
}

async function createSignedSession(
  app: ReturnType<typeof createApp>,
  keyPair: TestKeyPair = generateKeyPairSync("ed25519"),
) {
  const { privateKey, publicKey } = keyPair;
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const address = encodeStellarPublicKey(Buffer.from(publicKeyDer).subarray(-32));
  const challengeResponse = await app.handle(
    new Request("http://pnlx.local/auth/challenge", {
      method: "POST",
      body: body({ address }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(challengeResponse.status).toBe(201);
  const challenge = (await challengeResponse.json()) as Record<string, string>;
  const signature = sign(null, stellarSignedMessageHash(challenge.message), privateKey).toString("base64");
  const sessionResponse = await app.handle(
    new Request("http://pnlx.local/auth/session", {
      method: "POST",
      body: body({ address, nonce: challenge.nonce, signature }),
      headers: { "content-type": "application/json" },
    }),
  );
  expect(sessionResponse.status).toBe(201);
  const session = (await sessionResponse.json()) as Record<string, string>;
  return { address, token: session.token };
}

async function proveIntent(
  app: ReturnType<typeof createApp>,
  intent: Record<string, unknown>,
  note: Record<string, unknown>,
  membershipProof: Record<string, unknown>,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Record<string, unknown>> {
  const proofResponse = await app.handle(
    new Request("http://pnlx.local/proofs/intent", {
      method: "POST",
      body: body({
        ...intent,
        currentBatch: "1",
        expiryBatch: "2",
        assetDigest: note.assetDigest,
        blinding: note.blinding,
        marginRoot: membershipProof.root,
        noteAmount: note.amount,
        noteCommitment: note.commitment,
        ownerDigest: note.ownerDigest,
        pathIndices: membershipProof.indices,
        pathSiblings: membershipProof.siblings,
        rhoDigest: note.rhoDigest,
        spendSecretDigest: note.spendSecretDigest,
      }),
      headers,
    }),
  );
  expect(proofResponse.status).toBeLessThan(300);
  const proofResult = (await proofResponse.json()) as Record<string, unknown>;
  return proofResult.proof as Record<string, unknown>;
}

async function submitIntentRequest(
  app: ReturnType<typeof createApp>,
  intent: Record<string, unknown>,
  note: Record<string, unknown>,
  membershipProof: Record<string, unknown>,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Response> {
  const validity = await proveIntent(app, intent, note, membershipProof, headers);
  return app.handle(
    new Request("http://pnlx.local/intents", {
      method: "POST",
      body: body({ intent, validity }),
      headers,
    }),
  );
}

async function proveAndSubmitIntentRequest(
  app: ReturnType<typeof createApp>,
  intent: Record<string, unknown>,
  note: Record<string, unknown>,
  membershipProof: Record<string, unknown>,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Response> {
  return app.handle(
    new Request("http://pnlx.local/intents/prove-and-submit", {
      method: "POST",
      body: body({
        ...intent,
        currentBatch: "1",
        expiryBatch: "2",
        assetDigest: note.assetDigest,
        blinding: note.blinding,
        marginRoot: membershipProof.root,
        noteAmount: note.amount,
        noteCommitment: note.commitment,
        ownerDigest: note.ownerDigest,
        pathIndices: membershipProof.indices,
        pathSiblings: membershipProof.siblings,
        rhoDigest: note.rhoDigest,
        spendSecretDigest: note.spendSecretDigest,
      }),
      headers,
    }),
  );
}

function tradeIntentFromBody(input: Record<string, unknown>): TradeIntent {
  return {
    batchId: String(input.batchId),
    limitPrice: BigInt(String(input.limitPrice)),
    margin: BigInt(String(input.margin)),
    marketId: String(input.marketId),
    nonce: String(input.nonce),
    noteNullifier: String(input.noteNullifier) as Hex,
    owner: String(input.owner),
    salt: String(input.salt),
    side: input.side === "short" ? "short" : "long",
    size: BigInt(String(input.size)),
  };
}

function buildPrivateIntent(
  prover: ProverService,
  input: {
    batchId: string;
    limitPrice: bigint;
    margin: bigint;
    marketId: string;
    membershipProof: MarginMembershipProof;
    nonce: string;
    note: CircuitMarginNote;
    owner: string;
    salt: string;
    side: "long" | "short";
    size: bigint;
  },
) {
  const intent: TradeIntent = {
    batchId: input.batchId,
    limitPrice: input.limitPrice,
    margin: input.margin,
    marketId: input.marketId,
    nonce: input.nonce,
    noteNullifier: input.note.noteNullifier as Hex,
    owner: input.owner,
    salt: input.salt,
    side: input.side,
    size: input.size,
  };
  const validity = prover.proveIntentValidity({
    assetDigest: input.note.assetDigest as Hex,
    blinding: input.note.blinding as Hex,
    changeBlinding: "0x0",
    changeRhoDigest: "0x0",
    currentBatch: 1n,
    expiryBatch: 2n,
    intent,
    marginRoot: input.membershipProof.root as Hex,
    noteAmount: BigInt(String(input.note.amount)),
    noteChangeCommitment: "0x0",
    noteCommitment: input.note.commitment as Hex,
    ownerDigest: input.note.ownerDigest as Hex,
    pathIndices: input.membershipProof.indices as boolean[],
    pathSiblings: input.membershipProof.siblings as Hex[],
    rhoDigest: input.note.rhoDigest as Hex,
    spendSecretDigest: input.note.spendSecretDigest as Hex,
  });
  const record = {
    batchDigest: validity.batchDigest,
    batchId: intent.batchId,
    intentCommitment: validity.intentCommitment,
    marketDigest: validity.marketDigest,
    marketId: intent.marketId,
    marginRoot: validity.marginRoot,
    noteChangeCommitment: validity.noteChangeCommitment,
    noteNullifier: validity.noteNullifier,
    ownerCommitment: ownerCommitment(intent.owner),
    ownerCommitmentField: validity.ownerCommitmentField,
    proof: validity.proof,
  };

  return {
    intent,
    record,
    validity,
  };
}

function proofArtifactRegistrationBody(prover: ProverService, proof: ProofMeta) {
  const artifact = prover.artifactFor(proof);
  if (!artifact) throw new Error("missing proof artifact for registration test");
  return {
    bytecodeHash: artifact.bytecodeHash,
    proof,
    proofBase64: readFileSync(artifact.proofPath).toString("base64"),
    publicInputsBase64: readFileSync(artifact.publicInputsPath).toString("base64"),
    vkBase64: readFileSync(artifact.vkPath).toString("base64"),
    witnessHash: artifact.witnessHash,
  };
}

async function depositCircuitMarginNote(
  app: ReturnType<typeof createApp>,
  input: Parameters<typeof createCircuitMarginNote>[0],
  headers: Record<string, string> = { "content-type": "application/json" },
) {
  const note = createCircuitMarginNote(input);
  const depositResponse = await app.handle(
    new Request("http://pnlx.local/notes/deposit", {
      method: "POST",
      body: body({ commitment: note.commitment }),
      headers,
    }),
  );
  expect(depositResponse.status).toBeLessThan(300);
  const deposit = (await depositResponse.json()) as Record<string, Record<string, unknown>>;
  return {
    note,
    membershipProof: deposit.note.membershipProof as MarginMembershipProof,
  };
}

function createSettledPositionWitness(input: {
  allCommitments: Hex[];
  entryPrice: bigint;
  fillIndex: number;
  fundingIndex: bigint;
  intent: TradeIntent;
  margin: bigint;
  owner: string;
  side: "long" | "short";
  size: bigint;
}) {
  const intentCommitment = commitIntent({
    batchId: input.intent.batchId,
    marketId: input.intent.marketId,
    owner: input.intent.owner,
    side: input.side,
    size: input.size,
    limitPrice: input.intent.limitPrice,
    margin: input.margin,
    noteNullifier: input.intent.noteNullifier,
    nonce: input.intent.nonce,
    salt: input.intent.salt,
  });
  const owner = ownerCommitment(input.owner);
  const rho = `${intentCommitment}:position:${input.fillIndex}`;
  const position = createCircuitPositionNote({
    marketId: input.intent.marketId,
    side: input.side,
    size: input.size,
    entryPrice: input.entryPrice,
    margin: input.margin,
    fundingIndex: input.fundingIndex,
    owner,
    spendSecret: `${owner}:${rho}`,
    rho,
    blinding: `${intentCommitment}:blinding:${input.fillIndex}`,
  });
  const membershipProof = fieldMerkleProof(input.allCommitments, position.commitment as Hex);

  return { position, membershipProof };
}

async function createCloseableLongPositionFixture(
  app: ReturnType<typeof createApp>,
  clientProver: ProverService,
  suffix: string,
) {
  const market = {
    marketId: `btc-usd-perp-${suffix}`,
    oraclePrice: 50_000n * PRICE_SCALE,
    maxLeverage: 5n,
    initialMarginRate: 200_000n,
    maintenanceMarginRate: 100_000n,
    fundingIndex: 0n,
  };
  const post = async (path: string, data: unknown) => {
    const response = await app.handle(
      new Request(`http://pnlx.local${path}`, {
        method: "POST",
        body: body(data),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBeLessThan(300);
    return (await response.json()) as Record<string, Record<string, unknown>>;
  };

  await post("/markets", market);
  const longNote = await depositCircuitMarginNote(app, {
    assetId: "usdc",
    amount: 12_000n,
    owner: `${suffix}-long-owner`,
    spendSecret: `${suffix}-long-spend`,
    rho: `${suffix}-long-rho`,
    blinding: `${suffix}-long-blind`,
  });
  const shortNote = await depositCircuitMarginNote(app, {
    assetId: "usdc",
    amount: 12_000n,
    owner: `${suffix}-short-owner`,
    spendSecret: `${suffix}-short-spend`,
    rho: `${suffix}-short-rho`,
    blinding: `${suffix}-short-blind`,
  });
  const sharedMarginLeaves = [
    longNote.note.commitment as Hex,
    shortNote.note.commitment as Hex,
  ];
  const batchId = `${suffix}-batch`;
  const long = buildPrivateIntent(clientProver, {
    batchId,
    limitPrice: 51_000n * PRICE_SCALE,
    margin: 12_000n,
    marketId: market.marketId,
    note: longNote.note,
    membershipProof: fieldMerkleProof(sharedMarginLeaves, longNote.note.commitment as Hex),
    nonce: `${suffix}-long-intent`,
    owner: `${suffix}-long-owner`,
    salt: `${suffix}-long-salt`,
    side: "long",
    size: 1n,
  });
  const short = buildPrivateIntent(clientProver, {
    batchId,
    limitPrice: 49_000n * PRICE_SCALE,
    margin: 12_000n,
    marketId: market.marketId,
    note: shortNote.note,
    membershipProof: fieldMerkleProof(sharedMarginLeaves, shortNote.note.commitment as Hex),
    nonce: `${suffix}-short-intent`,
    owner: `${suffix}-short-owner`,
    salt: `${suffix}-short-salt`,
    side: "short",
    size: 1n,
  });

  await post("/intents", long);
  await post("/intents", short);
  const settlement = await post("/batches/settle", { batchId, marketId: market.marketId });
  const positionCommitments = settlement.settlement.newCommitments as Hex[];
  const closeMarkPrice = 56_000n * PRICE_SCALE;
  await post("/markets/update", { ...market, oraclePrice: closeMarkPrice });

  return {
    closeMarkPrice,
    long,
    longPosition: createSettledPositionWitness({
      allCommitments: positionCommitments,
      entryPrice: 51_000n * PRICE_SCALE,
      fillIndex: 0,
      fundingIndex: 0n,
      intent: long.intent,
      margin: 12_000n,
      owner: `${suffix}-long-owner`,
      side: "long",
      size: 1n,
    }),
    market,
    positionCommitments,
  };
}

function createDisclosureWitness(input: {
  claim: string;
  salt: string;
  subject: Hex;
  value: bigint;
}) {
  const claimDigest = hashFields("disclosure-claim", [input.claim]);
  const saltDigest = hashFields("disclosure-salt", [input.salt]);
  const commitment = circuitDisclosureCommitment({
    claimDigest,
    saltDigest,
    subject: input.subject,
    value: input.value,
  });
  const proof = fieldMerkleProof([commitment], commitment);
  return {
    claimDigest,
    commitment,
    pathIndices: proof.indices,
    pathSiblings: proof.siblings,
    root: proof.root,
    saltDigest,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("server api", () => {
  test("returns health", async () => {
    const result = await call("/health");
    expect(result.ok).toBe(true);
  });

  test("reports custody readiness and rejects unconfigured asset custody", async () => {
    const previousCustody = process.env.ASSET_CUSTODY_REQUIRED;
    const previousAsset = process.env.COLLATERAL_ASSET;
    const previousAssetCode = process.env.COLLATERAL_ASSET_CODE;
    const previousAssetIssuer = process.env.COLLATERAL_ASSET_ISSUER;
    const previousToken = process.env.COLLATERAL_TOKEN_CONTRACT;
    const previousRelay = process.env.STELLAR_ONCHAIN_RELAY;
    const previousRelayerMode = process.env.STELLAR_RELAYER_MODE;
    process.env.ASSET_CUSTODY_REQUIRED = "true";
    process.env.COLLATERAL_ASSET = "USDC:GISSUER";
    process.env.COLLATERAL_ASSET_CODE = "USDC";
    process.env.COLLATERAL_ASSET_ISSUER = "GISSUER";
    process.env.COLLATERAL_TOKEN_CONTRACT = "";
    process.env.STELLAR_ONCHAIN_RELAY = "false";
    process.env.STELLAR_RELAYER_MODE = "local";
    try {
      const app = createApp();
      const healthResponse = await app.handle(new Request("http://pnlx.local/health"));
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as Record<string, Record<string, unknown>>;
      const custody = health.custody;
      expect(custody.required).toBe(true);
      expect(custody.collateralAsset).toEqual({
        asset: "USDC:GISSUER",
        code: "USDC",
        issuer: "GISSUER",
        tokenContract: "",
      });
      expect(custody.readyForRealAssets).toBe(false);
      expect(custody.collateralTokenConfigured).toBe(false);
      expect(custody.onchainRelayEnabled).toBe(false);
      expect(custody.issues as string[]).toContain(
        "COLLATERAL_TOKEN_CONTRACT is required for asset custody",
      );

      const response = await app.handle(
        new Request("http://pnlx.local/notes/deposit-asset/prepare", {
          method: "POST",
          body: body({
            amount: "1000",
            commitment: hashFields("note", ["unconfigured-custody"]),
            from: "GTRADER",
            token: "CUSDC",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "collateral token contract not configured",
      });
    } finally {
      restoreEnv("ASSET_CUSTODY_REQUIRED", previousCustody);
      restoreEnv("COLLATERAL_ASSET", previousAsset);
      restoreEnv("COLLATERAL_ASSET_CODE", previousAssetCode);
      restoreEnv("COLLATERAL_ASSET_ISSUER", previousAssetIssuer);
      restoreEnv("COLLATERAL_TOKEN_CONTRACT", previousToken);
      restoreEnv("STELLAR_ONCHAIN_RELAY", previousRelay);
      restoreEnv("STELLAR_RELAYER_MODE", previousRelayerMode);
    }
  });

  test("reports conditional order readiness and blocks local TP/SL indexing when on-chain registration is required", async () => {
    const previousRequired = process.env.CONDITIONAL_ORDERS_ONCHAIN_REQUIRED;
    const previousRelay = process.env.STELLAR_ONCHAIN_RELAY;
    const previousRelayerMode = process.env.STELLAR_RELAYER_MODE;
    process.env.CONDITIONAL_ORDERS_ONCHAIN_REQUIRED = "true";
    process.env.STELLAR_ONCHAIN_RELAY = "false";
    process.env.STELLAR_RELAYER_MODE = "local";
    try {
      const app = createApp();
      const healthResponse = await app.handle(new Request("http://pnlx.local/health"));
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as Record<string, Record<string, unknown>>;
      expect(health.conditionalOrders).toEqual({
        onchainRequired: true,
        readyForOnchainRegistration: false,
        issues: [
          "STELLAR_ONCHAIN_RELAY must be enabled for on-chain conditional orders",
          "STELLAR_RELAYER_MODE must be stellar-cli for submitted conditional order transactions",
        ],
      });

      const response = await app.handle(
        new Request("http://pnlx.local/conditional-orders", {
          method: "POST",
          body: body({
            closeCommitment: hashFields("close", ["onchain-required"]),
            marketId: "btc-usd-perp",
            positionNullifier: hashFields("position-nullifier", ["onchain-required"]),
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "conditional orders require on-chain relay",
      });
    } finally {
      restoreEnv("CONDITIONAL_ORDERS_ONCHAIN_REQUIRED", previousRequired);
      restoreEnv("STELLAR_ONCHAIN_RELAY", previousRelay);
      restoreEnv("STELLAR_RELAYER_MODE", previousRelayerMode);
    }
  });

  test("reports settlement readiness when proof-backed mutations require on-chain finality", async () => {
    const previousRequired = process.env.SETTLEMENTS_ONCHAIN_REQUIRED;
    const previousRelay = process.env.STELLAR_ONCHAIN_RELAY;
    const previousRelayerMode = process.env.STELLAR_RELAYER_MODE;
    process.env.SETTLEMENTS_ONCHAIN_REQUIRED = "true";
    process.env.STELLAR_ONCHAIN_RELAY = "false";
    process.env.STELLAR_RELAYER_MODE = "local";
    try {
      const app = createApp();
      const healthResponse = await app.handle(new Request("http://pnlx.local/health"));
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as Record<string, Record<string, unknown>>;
      expect(health.settlements).toEqual({
        onchainRequired: true,
        readyForOnchainFinality: false,
        issues: [
          "STELLAR_ONCHAIN_RELAY must be enabled for on-chain settlement finality",
          "STELLAR_RELAYER_MODE must be stellar-cli for submitted settlement transactions",
        ],
      });
    } finally {
      restoreEnv("SETTLEMENTS_ONCHAIN_REQUIRED", previousRequired);
      restoreEnv("STELLAR_ONCHAIN_RELAY", previousRelay);
      restoreEnv("STELLAR_RELAYER_MODE", previousRelayerMode);
    }
  });

  test("reports intent registry readiness when order state requires on-chain registration", async () => {
    const previousRequired = process.env.INTENT_REGISTRY_ONCHAIN_REQUIRED;
    const previousRelay = process.env.STELLAR_ONCHAIN_RELAY;
    const previousRelayerMode = process.env.STELLAR_RELAYER_MODE;
    process.env.INTENT_REGISTRY_ONCHAIN_REQUIRED = "true";
    process.env.STELLAR_ONCHAIN_RELAY = "false";
    process.env.STELLAR_RELAYER_MODE = "local";
    try {
      const app = createApp();
      const healthResponse = await app.handle(new Request("http://pnlx.local/health"));
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as Record<string, Record<string, unknown>>;
      expect(health.intentRegistry).toEqual({
        onchainRequired: true,
        readyForOnchainRegistration: false,
        issues: [
          "STELLAR_ONCHAIN_RELAY must be enabled for on-chain intent registry",
          "STELLAR_RELAYER_MODE must be stellar-cli for submitted intent registry transactions",
        ],
      });
    } finally {
      restoreEnv("INTENT_REGISTRY_ONCHAIN_REQUIRED", previousRequired);
      restoreEnv("STELLAR_ONCHAIN_RELAY", previousRelay);
      restoreEnv("STELLAR_RELAYER_MODE", previousRelayerMode);
    }
  });

  test("reports RISC0 matcher readiness for private matcher service", async () => {
    const previousRequired = process.env.PRIVATE_MATCHING_REQUIRED;
    const previousMatcherUrl = process.env.MATCHER_SERVICE_URL;
    const previousLegacyMatcherUrl = process.env.EXTERNAL_MATCHER_URL;
    process.env.PRIVATE_MATCHING_REQUIRED = "true";
    process.env.MATCHER_SERVICE_URL = "https://matcher.pnlx.local";
    delete process.env.EXTERNAL_MATCHER_URL;
    try {
      const app = createApp();
      const healthResponse = await app.handle(new Request("http://pnlx.local/health"));
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as Record<string, Record<string, unknown>>;
      const matching = health.matching as Record<string, unknown>;
      expect(matching.readyForPrivateMatching).toBe(true);
      expect(matching.proofEngine).toEqual({
        provider: "risc0",
        proofSystem: "risc0-groth16",
      });
      expect(matching.issues).toEqual([]);
    } finally {
      restoreEnv("PRIVATE_MATCHING_REQUIRED", previousRequired);
      restoreEnv("MATCHER_SERVICE_URL", previousMatcherUrl);
      restoreEnv("EXTERNAL_MATCHER_URL", previousLegacyMatcherUrl);
    }
  });

  test("fails closed when private matching lacks a matcher service", () => {
    const previousPrivate = process.env.PRIVATE_MATCHING_REQUIRED;
    const previousUrl = process.env.MATCHER_SERVICE_URL;
    const previousLegacyUrl = process.env.EXTERNAL_MATCHER_URL;
    process.env.PRIVATE_MATCHING_REQUIRED = "true";
    process.env.MATCHER_SERVICE_URL = "";
    delete process.env.EXTERNAL_MATCHER_URL;

    try {
      expect(() => createAppRuntime()).toThrow(
        "MATCHER_SERVICE_URL is required for private matcher service",
      );
    } finally {
      restoreEnv("PRIVATE_MATCHING_REQUIRED", previousPrivate);
      restoreEnv("MATCHER_SERVICE_URL", previousUrl);
      restoreEnv("EXTERNAL_MATCHER_URL", previousLegacyUrl);
    }
  });

  test("serves RISC0 matcher settlement transcripts from persisted private match payloads", async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), "pnlx-risc0-matcher-store-")), "protocol-store.json");
    const executor = createFileExecutor(storePath);
    const clientProver = new ProverService();
    const market = {
      marketId: "btc-usd-perp-matcher-provider",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 200_000n,
      maintenanceMarginRate: 100_000n,
      fundingIndex: 0n,
    };
    executor.addMarket(market);

    const longNote = createCircuitMarginNote({
      assetId: "usdc",
      amount: 12_000n,
      owner: "matcher-provider-long",
      spendSecret: "matcher-provider-long-spend",
      rho: "matcher-provider-long-rho",
      blinding: "matcher-provider-long-blind",
    });
    const shortNote = createCircuitMarginNote({
      assetId: "usdc",
      amount: 12_000n,
      owner: "matcher-provider-short",
      spendSecret: "matcher-provider-short-spend",
      rho: "matcher-provider-short-rho",
      blinding: "matcher-provider-short-blind",
    });
    const leaves = [longNote.commitment as Hex, shortNote.commitment as Hex];
    for (const commitment of leaves) executor.deposit(commitment);

    const long = buildPrivateIntent(clientProver, {
      batchId: "matcher-provider-batch",
      limitPrice: 51_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: market.marketId,
      membershipProof: fieldMerkleProof(leaves, longNote.commitment as Hex),
      nonce: "matcher-provider-long-intent",
      note: longNote,
      owner: "matcher-provider-long",
      salt: "matcher-provider-long-salt",
      side: "long",
      size: 1n,
    });
    const short = buildPrivateIntent(clientProver, {
      batchId: "matcher-provider-batch",
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: market.marketId,
      membershipProof: fieldMerkleProof(leaves, shortNote.commitment as Hex),
      nonce: "matcher-provider-short-intent",
      note: shortNote,
      owner: "matcher-provider-short",
      salt: "matcher-provider-short-salt",
      side: "short",
      size: 1n,
    });
    executor.store.recordProof(long.validity.proof);
    executor.store.recordProof(short.validity.proof);
    executor.submitIntent({ intent: long.intent, validity: long.validity });
    executor.submitIntent({ intent: short.intent, validity: short.validity });
    executor.store.upsertAccountEncryptionKey({
      algorithm: "ecdh-p256-aes-gcm",
      createdAt: 1,
      ownerCommitment: long.record.ownerCommitment,
      publicKey: rawP256PublicKey(),
      updatedAt: 1,
    });
    executor.store.upsertAccountEncryptionKey({
      algorithm: "ecdh-p256-aes-gcm",
      createdAt: 1,
      ownerCommitment: short.record.ownerCommitment,
      publicKey: rawP256PublicKey(),
      updatedAt: 1,
    });

    const provider = createMatcherApp({
      executor,
      signerConfig: {
        proofs: prooflessProofs(),
      },
      token: "provider-secret",
    });
    const response = await provider.handle(
      new Request("http://provider.local/match/settlement", {
        method: "POST",
        body: body({
          batchId: "matcher-provider-batch",
          marketId: market.marketId,
        }),
        headers: {
          authorization: "Bearer provider-secret",
          "content-type": "application/json",
        },
      }),
    );
    expect(response.status).toBe(201);
    const transcript = (await response.json()) as Record<string, unknown>;
    expect(transcript).not.toHaveProperty("positionEvents");
    expect((transcript.accountEvents as unknown[])).toHaveLength(2);
    expect(JSON.stringify(transcript.accountEvents)).not.toContain("positionNullifier");
    const settlement = transcript.settlement as Record<string, unknown>;
    expect(settlement.fillCount).toBe(2);
    expect(settlement.proof).toMatchObject({
      circuitId: "batch-match",
      proofSystem: "risc0-groth16",
    });
    expect(transcript.positionOpenings as unknown[]).toHaveLength(2);
    expect(JSON.stringify(transcript)).not.toContain("matcher-provider-long-spend");
  });

  test("requires on-chain relay and oracle contract when production oracle mode is enabled", async () => {
    const previousRequired = process.env.ORACLE_ONCHAIN_REQUIRED;
    const previousSource = process.env.ORACLE_PRICE_SOURCE;
    const previousRelay = process.env.STELLAR_ONCHAIN_RELAY;
    const previousRelayerMode = process.env.STELLAR_RELAYER_MODE;
    const previousContract = process.env.ORACLE_CONTRACT_ID;
    process.env.ORACLE_ONCHAIN_REQUIRED = "true";
    process.env.ORACLE_PRICE_SOURCE = "hermes";
    process.env.STELLAR_ONCHAIN_RELAY = "false";
    process.env.STELLAR_RELAYER_MODE = "local";
    process.env.ORACLE_CONTRACT_ID = "";
    try {
      const app = createApp();
      const healthResponse = await app.handle(new Request("http://pnlx.local/health"));
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as Record<string, Record<string, unknown>>;
      expect(health.oracle.source).toBe("hermes");
      expect(health.oracle.onchainRequired).toBe(true);
      expect(health.oracle.issues as string[]).toContain(
        "STELLAR_ONCHAIN_RELAY must be enabled for on-chain oracle reads",
      );
      expect(health.oracle.issues as string[]).toContain(
        "ORACLE_CONTRACT_ID is required for on-chain oracle settlement",
      );

      const marketResponse = await app.handle(
        new Request("http://pnlx.local/markets/oracle", {
          method: "POST",
          body: body({
            marketId: "btc-usd-perp",
            maxLeverage: "10",
            initialMarginRate: "100000",
            maintenanceMarginRate: "50000",
            fundingIndex: "0",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(marketResponse.status).toBe(500);
      expect(await marketResponse.json()).toEqual({
        error:
          "oracle not ready for production authority: STELLAR_ONCHAIN_RELAY must be enabled for on-chain oracle reads",
      });
    } finally {
      restoreEnv("ORACLE_ONCHAIN_REQUIRED", previousRequired);
      restoreEnv("ORACLE_PRICE_SOURCE", previousSource);
      restoreEnv("STELLAR_ONCHAIN_RELAY", previousRelay);
      restoreEnv("STELLAR_RELAYER_MODE", previousRelayerMode);
      restoreEnv("ORACLE_CONTRACT_ID", previousContract);
    }
  });

  test("reports oracle committee readiness", async () => {
    const previousRelay = process.env.STELLAR_ONCHAIN_RELAY;
    const previousRelayerMode = process.env.STELLAR_RELAYER_MODE;
    const previousContract = process.env.ORACLE_CONTRACT_ID;
    const previousMode = process.env.ORACLE_PUBLISH_MODE;
    const previousThreshold = process.env.ORACLE_COMMITTEE_THRESHOLD;
    const previousAddresses = process.env.ORACLE_PUBLISHER_ADDRESSES;
    const previousSources = process.env.ORACLE_PUBLISHER_SOURCES;

    process.env.STELLAR_ONCHAIN_RELAY = "true";
    process.env.STELLAR_RELAYER_MODE = "stellar-cli";
    process.env.ORACLE_CONTRACT_ID = "CORACLE";
    process.env.ORACLE_PUBLISH_MODE = "committee";
    process.env.ORACLE_COMMITTEE_THRESHOLD = "2";
    process.env.ORACLE_PUBLISHER_ADDRESSES = "";
    process.env.ORACLE_PUBLISHER_SOURCES = "oracle-a,oracle-b";

    try {
      const missing = createApp();
      const missingResponse = await missing.handle(new Request("http://pnlx.local/health"));
      const missingHealth = (await missingResponse.json()) as Record<string, Record<string, unknown>>;
      expect(missingHealth.oracle.issues as string[]).toContain(
        "ORACLE_PUBLISHER_ADDRESSES must include at least ORACLE_COMMITTEE_THRESHOLD publishers",
      );

      process.env.ORACLE_PUBLISHER_ADDRESSES = "GPUBLISHERA,GPUBLISHERB";
      const ready = createApp();
      const readyResponse = await ready.handle(new Request("http://pnlx.local/health"));
      const readyHealth = (await readyResponse.json()) as Record<string, Record<string, unknown>>;
      const oracle = readyHealth.oracle as Record<string, unknown>;
      expect(oracle.issues).toEqual([]);
      expect(oracle.publisherCount).toBe(2);
      expect(oracle.committee).toEqual(expect.objectContaining({
        ready: true,
        threshold: 2,
      }));
    } finally {
      restoreEnv("STELLAR_ONCHAIN_RELAY", previousRelay);
      restoreEnv("STELLAR_RELAYER_MODE", previousRelayerMode);
      restoreEnv("ORACLE_CONTRACT_ID", previousContract);
      restoreEnv("ORACLE_PUBLISH_MODE", previousMode);
      restoreEnv("ORACLE_COMMITTEE_THRESHOLD", previousThreshold);
      restoreEnv("ORACLE_PUBLISHER_ADDRESSES", previousAddresses);
      restoreEnv("ORACLE_PUBLISHER_SOURCES", previousSources);
    }
  });

  test("returns verifier registry entries", async () => {
    const result = await call("/proofs/verifiers");
    const verifiers = result.verifiers as Record<string, string>[];
    const batchVerifier = verifiers.find((entry) => entry.circuitId === "batch-match");

    expect(verifiers).toHaveLength(11);
    expect(batchVerifier?.circuitKey).toBe(RISC0_BATCH_MATCH_CIRCUIT_KEY);
    expect(batchVerifier?.verifierHash).toBe(RISC0_STELLAR_VERIFIER_HASH);
    expect(batchVerifier?.verifierAuthority).toBe("batch-match-risc0-verifier");
    expect(batchVerifier?.verifierContract).toBe("risc0-proof-verifier");
  });

  test("keeps witness-producing helper routes disabled outside dev/test opt-in", async () => {
    const previous = process.env.SERVER_WITNESS_ROUTES_ENABLED;
    process.env.SERVER_WITNESS_ROUTES_ENABLED = "false";
    try {
      const app = createApp();
      const healthResponse = await app.handle(new Request("http://pnlx.local/health"));
      const health = (await healthResponse.json()) as Record<string, Record<string, unknown>>;
      expect((health.privacy as Record<string, unknown>).serverWitnessRoutesEnabled).toBe(false);

      const verifiers = await app.handle(new Request("http://pnlx.local/proofs/verifiers"));
      expect(verifiers.status).toBe(200);

      for (const path of [
        "/proofs/intent",
        "/proofs/liquidation",
        "/proofs/disclosure",
        "/intents",
        "/intents/prove-and-submit",
        "/notes/deposit",
        "/notes/deposit-asset",
        "/notes/withdraw",
        "/notes/withdraw-asset",
        "/liquidations",
        "/conditional-orders/trigger",
        "/conditional-orders/execute",
        "/position-closes",
        "/position-closes/manual",
        "/disclosures",
        "/orders/replace",
      ]) {
        const response = await app.handle(
          new Request(`http://pnlx.local${path}`, {
            method: "POST",
            body: body({}),
            headers: { "content-type": "application/json" },
          }),
        );
        expect(response.status).toBe(404);
      }
    } finally {
      restoreEnv("SERVER_WITNESS_ROUTES_ENABLED", previous);
    }
  });

  test("registers client-generated proof artifacts without enabling witness routes", async () => {
    const previousWitness = process.env.SERVER_WITNESS_ROUTES_ENABLED;
    process.env.SERVER_WITNESS_ROUTES_ENABLED = "false";
    try {
      const app = createApp();
      const clientProver = new ProverService();
      const subject = hashFields("subject", ["registered-client-proof"]);
      const claim = "registered-client-disclosure";
      const witness = createDisclosureWitness({
        claim,
        salt: "registered-client-disclosure-salt",
        subject,
        value: 50n,
      });
      const disclosure = clientProver.proveDisclosure({
        claim,
        pathIndices: witness.pathIndices,
        pathSiblings: witness.pathSiblings,
        root: witness.root,
        salt: "registered-client-disclosure-salt",
        saltDigest: witness.saltDigest,
        subject,
        threshold: 100n,
        value: 50n,
      });

      const response = await app.handle(
        new Request("http://pnlx.local/proofs/artifacts", {
          method: "POST",
          body: body(proofArtifactRegistrationBody(clientProver, disclosure.proof)),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(response.status).toBe(201);
      const result = (await response.json()) as Record<string, Record<string, string>>;
      expect(result.artifact.circuitId).toBe("disclosure");
      expect(result.artifact.proofHash).toBe(disclosure.proof.proofDigest);
      expect(JSON.stringify(result)).not.toContain("client-proof-artifacts");

      const witnessResponse = await app.handle(
        new Request("http://pnlx.local/proofs/disclosure", {
          method: "POST",
          body: body({}),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(witnessResponse.status).toBe(404);
    } finally {
      restoreEnv("SERVER_WITNESS_ROUTES_ENABLED", previousWitness);
    }
  });

  test("requires signed Stellar account sessions when auth is enabled", async () => {
    const previous = process.env.AUTH_REQUIRED;
    const previousAdmin = process.env.PROTOCOL_ADMIN_ADDRESSES;
    process.env.AUTH_REQUIRED = "true";
    process.env.PROTOCOL_ADMIN_ADDRESSES = "";
    try {
      const app = createApp();
      const market = {
        marketId: "admin-auth-btc-usd-perp",
        oraclePrice: 50_000n * PRICE_SCALE,
        maxLeverage: 5n,
        initialMarginRate: 200_000n,
        maintenanceMarginRate: 100_000n,
        fundingIndex: 0n,
      };
      const blocked = await app.handle(
        new Request("http://pnlx.local/markets", {
          method: "POST",
          body: body(market),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(blocked.status).toBe(401);

      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
      const address = encodeStellarPublicKey(Buffer.from(publicKeyDer).subarray(-32));
      const challengeResponse = await app.handle(
        new Request("http://pnlx.local/auth/challenge", {
          method: "POST",
          body: body({ address }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(challengeResponse.status).toBe(201);
      const challenge = (await challengeResponse.json()) as Record<string, string>;
      expect(challenge.domain).toBe("pnlx.local");
      expect(challenge.ownerCommitment).toBe(ownerCommitment(address));
      expect(challenge.signingMode).toBe("stellar-ed25519-message");
      expect(challenge.message).toContain("Domain: pnlx.local");
      const signature = sign(null, stellarSignedMessageHash(challenge.message), privateKey).toString("base64");
      const sessionResponse = await app.handle(
        new Request("http://pnlx.local/auth/session", {
          method: "POST",
          body: body({ address, nonce: challenge.nonce, signature }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(sessionResponse.status).toBe(201);
      const session = (await sessionResponse.json()) as Record<string, string>;
      expect(session.ownerCommitment).toBe(ownerCommitment(address));
      expect(session.signingMode).toBe("stellar-ed25519-message");

      const currentSession = await app.handle(
        new Request("http://pnlx.local/auth/session", {
          headers: {
            authorization: `Bearer ${session.token}`,
          },
        }),
      );
      expect(currentSession.status).toBe(200);
      expect(await currentSession.json()).toEqual({
        address,
        expiresAt: session.expiresAt,
        ownerCommitment: ownerCommitment(address),
        signingMode: "stellar-ed25519-message",
      });

      const invalidSession = await app.handle(
        new Request("http://pnlx.local/auth/session", {
          headers: {
            authorization: "Bearer not-a-real-token",
          },
        }),
      );
      expect(invalidSession.status).toBe(401);
      expect(await invalidSession.json()).toEqual({ error: "invalid auth token" });

      const allowed = await app.handle(
        new Request("http://pnlx.local/markets", {
          method: "POST",
          body: body(market),
          headers: {
            authorization: `Bearer ${session.token}`,
            "content-type": "application/json",
          },
        }),
      );
      expect(allowed.status).toBe(201);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTH_REQUIRED;
      } else {
        process.env.AUTH_REQUIRED = previous;
      }
      restoreEnv("PROTOCOL_ADMIN_ADDRESSES", previousAdmin);
    }
  });

  test("authenticates signed sessions without file-backed auth state", async () => {
    const previousRequired = process.env.AUTH_REQUIRED;
    const previousAdmin = process.env.PROTOCOL_ADMIN_ADDRESSES;
    process.env.AUTH_REQUIRED = "true";
    process.env.PROTOCOL_ADMIN_ADDRESSES = "";
    try {
      const app = createApp();
      const { address, token } = await createSignedSession(app);
      const market = {
        marketId: "btc-usd-perp",
        oraclePrice: 50_000n * PRICE_SCALE,
        maxLeverage: 5n,
        initialMarginRate: 200_000n,
        maintenanceMarginRate: 100_000n,
        fundingIndex: 0n,
      };

      const response = await app.handle(
        new Request("http://pnlx.local/markets", {
          method: "POST",
          body: body(market),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        }),
      );

      expect(response.status).toBe(201);
      const currentSession = await app.handle(
        new Request("http://pnlx.local/auth/session", {
          headers: {
            authorization: `Bearer ${token}`,
          },
        }),
      );
      expect(currentSession.status).toBe(200);
      const session = (await currentSession.json()) as Record<string, string>;
      expect(session.address).toBe(address);
      expect(session.ownerCommitment).toBe(ownerCommitment(address));
    } finally {
      if (previousRequired === undefined) {
        delete process.env.AUTH_REQUIRED;
      } else {
        process.env.AUTH_REQUIRED = previousRequired;
      }
      restoreEnv("PROTOCOL_ADMIN_ADDRESSES", previousAdmin);
    }
  });

  test("requires protocol admin sessions for market and manual funding mutations", async () => {
    const previousRequired = process.env.AUTH_REQUIRED;
    const previousAdmin = process.env.PROTOCOL_ADMIN_ADDRESSES;
    const adminKeyPair = generateKeyPairSync("ed25519");
    const adminPublicKeyDer = adminKeyPair.publicKey.export({ format: "der", type: "spki" });
    const adminAddress = encodeStellarPublicKey(Buffer.from(adminPublicKeyDer).subarray(-32));
    process.env.AUTH_REQUIRED = "true";
    process.env.PROTOCOL_ADMIN_ADDRESSES = adminAddress;
    try {
      const app = createApp();
      const admin = await createSignedSession(app, adminKeyPair);
      const trader = await createSignedSession(app);
      const market = {
        marketId: "admin-mutations-btc-usd-perp",
        oraclePrice: 50_000n * PRICE_SCALE,
        maxLeverage: 10n,
        initialMarginRate: 100_000n,
        maintenanceMarginRate: 50_000n,
        fundingIndex: 0n,
      };
      const traderHeaders = {
        authorization: `Bearer ${trader.token}`,
        "content-type": "application/json",
      };
      const adminHeaders = {
        authorization: `Bearer ${admin.token}`,
        "content-type": "application/json",
      };

      const blockedMarket = await app.handle(
        new Request("http://pnlx.local/markets", {
          method: "POST",
          body: body(market),
          headers: traderHeaders,
        }),
      );
      expect(blockedMarket.status).toBe(500);
      expect(await blockedMarket.json()).toEqual({
        error: "authenticated account is not a protocol admin",
      });

      const allowedMarket = await app.handle(
        new Request("http://pnlx.local/markets", {
          method: "POST",
          body: body(market),
          headers: adminHeaders,
        }),
      );
      expect(allowedMarket.status).toBe(201);

      const blockedBatchSettlement = await app.handle(
        new Request("http://pnlx.local/batches/settle", {
          method: "POST",
          body: body({ batchId: "admin-gated-batch", marketId: market.marketId }),
          headers: traderHeaders,
        }),
      );
      expect(blockedBatchSettlement.status).toBe(500);
      expect(await blockedBatchSettlement.json()).toEqual({
        error: "authenticated account is not a protocol admin",
      });

      const blockedExternalSettlement = await app.handle(
        new Request("http://pnlx.local/batches/settle-external", {
          method: "POST",
          body: body({}),
          headers: traderHeaders,
        }),
      );
      expect(blockedExternalSettlement.status).toBe(500);
      expect(await blockedExternalSettlement.json()).toEqual({
        error: "authenticated account is not a protocol admin",
      });

      const updatedMarket = {
        ...market,
        maxLeverage: 5n,
        initialMarginRate: 200_000n,
        maintenanceMarginRate: 100_000n,
        oraclePrice: 51_000n * PRICE_SCALE,
      };
      const blockedUpdate = await app.handle(
        new Request("http://pnlx.local/markets/update", {
          method: "POST",
          body: body(updatedMarket),
          headers: traderHeaders,
        }),
      );
      expect(blockedUpdate.status).toBe(500);
      expect(await blockedUpdate.json()).toEqual({
        error: "authenticated account is not a protocol admin",
      });

      const allowedUpdate = await app.handle(
        new Request("http://pnlx.local/markets/update", {
          method: "POST",
          body: body(updatedMarket),
          headers: adminHeaders,
        }),
      );
      expect(allowedUpdate.status).toBe(200);
      const updateResult = (await allowedUpdate.json()) as Record<string, Record<string, string>>;
      expect(updateResult.market.maxLeverage).toBe("5");
      expect(updateResult.market.oraclePrice).toBe((51_000n * PRICE_SCALE).toString());

      const blockedFunding = await app.handle(
        new Request("http://pnlx.local/funding/advance", {
          method: "POST",
          body: body({
            fundingDelta: "1",
            marketId: market.marketId,
          }),
          headers: traderHeaders,
        }),
      );
      expect(blockedFunding.status).toBe(500);
      expect(await blockedFunding.json()).toEqual({
        error: "authenticated account is not a protocol admin",
      });

      const allowedFunding = await app.handle(
        new Request("http://pnlx.local/funding/advance", {
          method: "POST",
          body: body({
            fundingDelta: "1",
            marketId: market.marketId,
          }),
          headers: adminHeaders,
        }),
      );
      expect(allowedFunding.status).toBe(201);

      const relayPayload = {
        kind: "contract-invoke",
        payload: {
          args: [],
          contractId: "contract-id",
          functionName: "noop",
        },
      };
      const blockedRelay = await app.handle(
        new Request("http://pnlx.local/relays", {
          method: "POST",
          body: body(relayPayload),
          headers: traderHeaders,
        }),
      );
      expect(blockedRelay.status).toBe(500);
      expect(await blockedRelay.json()).toEqual({
        error: "authenticated account is not a protocol admin",
      });

      const allowedRelay = await app.handle(
        new Request("http://pnlx.local/relays", {
          method: "POST",
          body: body(relayPayload),
          headers: adminHeaders,
        }),
      );
      expect(allowedRelay.status).toBe(201);
    } finally {
      restoreEnv("AUTH_REQUIRED", previousRequired);
      restoreEnv("PROTOCOL_ADMIN_ADDRESSES", previousAdmin);
    }
  });

  test("fails closed for governed mutations when protocol admins are required but missing", async () => {
    const previousRequired = process.env.AUTH_REQUIRED;
    const previousAdmin = process.env.PROTOCOL_ADMIN_ADDRESSES;
    const previousAdminRequired = process.env.PROTOCOL_ADMIN_REQUIRED;
    process.env.AUTH_REQUIRED = "true";
    process.env.PROTOCOL_ADMIN_ADDRESSES = "";
    process.env.PROTOCOL_ADMIN_REQUIRED = "true";
    try {
      const app = createApp();
      const trader = await createSignedSession(app);
      const healthResponse = await app.handle(new Request("http://pnlx.local/health"));
      expect(healthResponse.status).toBe(200);
      const health = (await healthResponse.json()) as Record<string, Record<string, unknown>>;
      expect(health.governance).toEqual({
        protocolAdminCount: 0,
        protocolAdminRequired: true,
        readyForGovernedMutations: false,
        issues: ["PROTOCOL_ADMIN_ADDRESSES is required for governed mutations"],
      });

      const blockedMarket = await app.handle(
        new Request("http://pnlx.local/markets", {
          method: "POST",
          body: body({
            marketId: "btc-usd-perp",
            oraclePrice: 50_000n * PRICE_SCALE,
            maxLeverage: 10n,
            initialMarginRate: 100_000n,
            maintenanceMarginRate: 50_000n,
            fundingIndex: 0n,
          }),
          headers: {
            authorization: `Bearer ${trader.token}`,
            "content-type": "application/json",
          },
        }),
      );
      expect(blockedMarket.status).toBe(500);
      expect(await blockedMarket.json()).toEqual({
        error: "protocol admin addresses are not configured",
      });
    } finally {
      restoreEnv("AUTH_REQUIRED", previousRequired);
      restoreEnv("PROTOCOL_ADMIN_ADDRESSES", previousAdmin);
      restoreEnv("PROTOCOL_ADMIN_REQUIRED", previousAdminRequired);
    }
  });

  test("requires asset-backed collateral when custody mode is enabled", async () => {
    const previousCustody = process.env.ASSET_CUSTODY_REQUIRED;
    process.env.ASSET_CUSTODY_REQUIRED = "true";
    try {
      const app = createApp();
      const commitment = hashFields("note", ["custody-required"]);

      const plainDeposit = await app.handle(
        new Request("http://pnlx.local/notes/deposit", {
          method: "POST",
          body: body({ commitment }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(plainDeposit.status).toBe(500);
      expect(await plainDeposit.json()).toEqual({
        error: "plain deposits disabled; use asset-backed deposit",
      });

      const plainWithdrawal = await app.handle(
        new Request("http://pnlx.local/notes/withdraw", {
          method: "POST",
          body: body({
            assetDigest: hashFields("asset", ["custody-required"]),
            blinding: hashFields("blinding", ["custody-required"]),
            noteAmount: "1000",
            noteCommitment: hashFields("note", ["custody-required"]),
            withdrawAmount: "100",
            ownerDigest: hashFields("owner", ["custody-required"]),
            pathIndices: [false, false, false, false, false, false, false, false],
            pathSiblings: [
              hashFields("sibling", [0]),
              hashFields("sibling", [1]),
              hashFields("sibling", [2]),
              hashFields("sibling", [3]),
              hashFields("sibling", [4]),
              hashFields("sibling", [5]),
              hashFields("sibling", [6]),
              hashFields("sibling", [7]),
            ],
            root: hashFields("root", ["custody-required"]),
            rhoDigest: hashFields("rho", ["custody-required"]),
            nullifier: hashFields("nullifier", ["custody-required"]),
            recipient: hashFields("recipient", ["custody-required"]),
            spendSecretDigest: hashFields("spend", ["custody-required"]),
            tokenDigest: hashFields("asset", ["custody-required"]),
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(plainWithdrawal.status).toBe(500);
      expect(await plainWithdrawal.json()).toEqual({
        error: "plain withdrawals disabled; use asset-backed withdrawal",
      });
    } finally {
      restoreEnv("ASSET_CUSTODY_REQUIRED", previousCustody);
    }
  });

  test("rejects asset deposits for unsupported collateral tokens", async () => {
    const previousToken = process.env.COLLATERAL_TOKEN_CONTRACT;
    process.env.COLLATERAL_TOKEN_CONTRACT = "CUSDC";
    try {
      const app = createApp();
      const response = await app.handle(
        new Request("http://pnlx.local/notes/deposit-asset/prepare", {
          method: "POST",
          body: body({
            amount: "1000",
            commitment: hashFields("note", ["wrong-collateral-token"]),
            from: "GTRADER",
            token: "CNOTUSDC",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "unsupported collateral token",
      });
    } finally {
      restoreEnv("COLLATERAL_TOKEN_CONTRACT", previousToken);
    }
  });

  test("fails closed when asset deposit preparation cannot read custody state", async () => {
    const previousToken = process.env.COLLATERAL_TOKEN_CONTRACT;
    const previousRelay = process.env.STELLAR_ONCHAIN_RELAY;
    process.env.COLLATERAL_TOKEN_CONTRACT = "CUSDC";
    process.env.STELLAR_ONCHAIN_RELAY = "true";
    try {
      const app = createApp();
      const incomplete = await app.handle(
        new Request("http://pnlx.local/notes/deposit-asset/prepare", {
          method: "POST",
          body: body({
            amount: "1000",
            commitment: hashFields("note", ["missing-deposit-opening"]),
            from: "GTRADER",
            token: "CUSDC",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(incomplete.status).toBe(500);
      expect(await incomplete.json()).toEqual({
        error: "stellar-cli relayer mode is required to read contract state",
      });

      const mismatched = await app.handle(
        new Request("http://pnlx.local/notes/deposit-asset/prepare", {
          method: "POST",
          body: body({
            amount: "1000",
            blinding: hashFields("blinding", ["deposit-opening"]),
            commitment: hashFields("note", ["wrong-deposit-opening"]),
            from: "GTRADER",
            ownerDigest: hashFields("owner", ["deposit-opening"]),
            rhoDigest: hashFields("rho", ["deposit-opening"]),
            token: "CUSDC",
            tokenDigest: hashFields("token", ["deposit-opening"]),
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(mismatched.status).toBe(500);
      expect(await mismatched.json()).toEqual({
        error: "stellar-cli relayer mode is required to read contract state",
      });
    } finally {
      restoreEnv("COLLATERAL_TOKEN_CONTRACT", previousToken);
      restoreEnv("STELLAR_ONCHAIN_RELAY", previousRelay);
    }
  });

  test("serves encrypted account events and portfolio snapshots", async () => {
    const app = createApp();
    const ownerCommitment = hashFields("owner", ["encrypted-portfolio"]);
    const event = {
      ciphertext: "base64:jwe-client-encrypted-position-history",
      dataCommitment: hashFields("account-event-data", ["position-open"]),
      eventId: hashFields("account-event", ["position-open"]),
      ownerCommitment,
    };

    const createResponse = await app.handle(
      new Request("http://pnlx.local/account-events", {
        method: "POST",
        body: body(event),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(createResponse.status).toBe(201);

    const eventsResponse = await app.handle(
      new Request(`http://pnlx.local/account-events?ownerCommitment=${ownerCommitment}`),
    );
    expect(eventsResponse.status).toBe(200);
    const eventsResult = (await eventsResponse.json()) as Record<string, unknown>;
    const accountEvents = eventsResult.accountEvents as Record<string, unknown>[];
    expect(accountEvents).toHaveLength(1);
    expect(accountEvents[0].ciphertext).toBe(event.ciphertext);

    const portfolioResponse = await app.handle(
      new Request(`http://pnlx.local/portfolio?ownerCommitment=${ownerCommitment}`),
    );
    expect(portfolioResponse.status).toBe(200);
    const portfolioResult = (await portfolioResponse.json()) as Record<string, Record<string, unknown>>;
    const portfolio = portfolioResult.portfolio;
    const publicState = portfolio.publicState as Record<string, unknown>;
    expect((portfolio.accountEvents as unknown[])).toHaveLength(1);
    expect(publicState.accountEventCount).toBe(1);
    expect(JSON.stringify(portfolio)).not.toContain("position-open");

    const balancesResponse = await app.handle(
      new Request(`http://pnlx.local/portfolio/balances?ownerCommitment=${ownerCommitment}`),
    );
    expect(balancesResponse.status).toBe(200);
    const balancesResult = (await balancesResponse.json()) as Record<string, Record<string, unknown>>;
    expect((balancesResult.balances.accountEvents as unknown[])).toHaveLength(1);
    expect(balancesResult.balances.serverReadableBalance).toBe(false);
    expect(balancesResult.balances.privateByDefault).toBe(true);
    expect(JSON.stringify(balancesResult)).not.toContain("position-open");

    const activityResponse = await app.handle(
      new Request(`http://pnlx.local/portfolio/activity?ownerCommitment=${ownerCommitment}`),
    );
    expect(activityResponse.status).toBe(200);
    const activityResult = (await activityResponse.json()) as Record<string, unknown>;
    const activity = activityResult.activity as Record<string, unknown>[];
    expect(activity.map((item) => item.kind)).toEqual(["account-event"]);
  });

  test("binds encrypted account events and portfolio reads to signed owner commitments", async () => {
    const previousRequired = process.env.AUTH_REQUIRED;
    process.env.AUTH_REQUIRED = "true";
    try {
      const app = createApp();
      const { address, token } = await createSignedSession(app);
      const other = await createSignedSession(app);
      const ownCommitment = ownerCommitment(address);
      const otherCommitment = ownerCommitment(other.address);
      const authHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      const event = {
        ciphertext: "base64:encrypted-owned-history",
        dataCommitment: hashFields("account-event-data", ["owned-position-open"]),
        eventId: hashFields("account-event", ["owned-position-open"]),
        ownerCommitment: ownCommitment,
      };

      const missingAuthRead = await app.handle(
        new Request(`http://pnlx.local/account-events?ownerCommitment=${ownCommitment}`),
      );
      expect(missingAuthRead.status).toBe(401);

      const createResponse = await app.handle(
        new Request("http://pnlx.local/account-events", {
          method: "POST",
          body: body(event),
          headers: authHeaders,
        }),
      );
      expect(createResponse.status).toBe(201);

      const foreignCreate = await app.handle(
        new Request("http://pnlx.local/account-events", {
          method: "POST",
          body: body({
            ...event,
            eventId: hashFields("account-event", ["foreign-owned-position-open"]),
            ownerCommitment: otherCommitment,
          }),
          headers: authHeaders,
        }),
      );
      expect(foreignCreate.status).toBe(500);
      expect(await foreignCreate.json()).toEqual({
        error: "ownerCommitment does not match authenticated account",
      });

      const foreignRead = await app.handle(
        new Request(`http://pnlx.local/portfolio?ownerCommitment=${otherCommitment}`, {
          headers: authHeaders,
        }),
      );
      expect(foreignRead.status).toBe(500);
      expect(await foreignRead.json()).toEqual({
        error: "ownerCommitment does not match authenticated account",
      });

      const ownRead = await app.handle(
        new Request(`http://pnlx.local/portfolio?ownerCommitment=${ownCommitment}`, {
          headers: authHeaders,
        }),
      );
      expect(ownRead.status).toBe(200);
      const ownPortfolio = (await ownRead.json()) as Record<string, Record<string, unknown>>;
      expect((ownPortfolio.portfolio.accountEvents as unknown[])).toHaveLength(1);
      expect(JSON.stringify(ownPortfolio)).not.toContain("owned-position-open");

      const foreignOrders = await app.handle(
        new Request(`http://pnlx.local/portfolio/orders?ownerCommitment=${otherCommitment}`, {
          headers: authHeaders,
        }),
      );
      expect(foreignOrders.status).toBe(500);
      expect(await foreignOrders.json()).toEqual({
        error: "ownerCommitment does not match authenticated account",
      });

      const ownBalances = await app.handle(
        new Request(`http://pnlx.local/portfolio/balances?ownerCommitment=${ownCommitment}`, {
          headers: authHeaders,
        }),
      );
      expect(ownBalances.status).toBe(200);
      const balances = (await ownBalances.json()) as Record<string, Record<string, unknown>>;
      expect((balances.balances.accountEvents as unknown[])).toHaveLength(1);
    } finally {
      restoreEnv("AUTH_REQUIRED", previousRequired);
    }
  });

  test("binds account encryption keys to signed owner commitments", async () => {
    const previousRequired = process.env.AUTH_REQUIRED;
    process.env.AUTH_REQUIRED = "true";
    try {
      const app = createApp();
      const { address, token } = await createSignedSession(app);
      const other = await createSignedSession(app);
      const ownCommitment = ownerCommitment(address);
      const otherCommitment = ownerCommitment(other.address);
      const authHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };
      const publicKey = rawP256PublicKey();

      const createResponse = await app.handle(
        new Request("http://pnlx.local/account-keys", {
          method: "POST",
          body: body({
            algorithm: "ecdh-p256-aes-gcm",
            ownerCommitment: ownCommitment,
            publicKey,
          }),
          headers: authHeaders,
        }),
      );
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as Record<string, Record<string, string>>;
      expect(created.accountKey.publicKey).toBe(publicKey);

      const rotateResponse = await app.handle(
        new Request("http://pnlx.local/account-keys", {
          method: "POST",
          body: body({
            algorithm: "ecdh-p256-aes-gcm",
            ownerCommitment: ownCommitment,
            publicKey: rawP256PublicKey(),
          }),
          headers: authHeaders,
        }),
      );
      expect(rotateResponse.status).toBe(500);
      expect(await rotateResponse.json()).toEqual({
        error: "account encryption key is already registered for this owner",
      });

      const foreignResponse = await app.handle(
        new Request("http://pnlx.local/account-keys", {
          method: "POST",
          body: body({
            algorithm: "ecdh-p256-aes-gcm",
            ownerCommitment: otherCommitment,
            publicKey: rawP256PublicKey(),
          }),
          headers: authHeaders,
        }),
      );
      expect(foreignResponse.status).toBe(500);
      expect(await foreignResponse.json()).toEqual({
        error: "ownerCommitment does not match authenticated account",
      });

      const recoveryKey = rawP256PublicKey();
      const recoveryResponse = await app.handle(
        new Request("http://pnlx.local/account-keys/recover", {
          method: "POST",
          body: body({
            algorithm: "ecdh-p256-aes-gcm",
            ownerCommitment: ownCommitment,
            publicKey: recoveryKey,
          }),
          headers: authHeaders,
        }),
      );
      expect(recoveryResponse.status).toBe(201);
      const recovered = (await recoveryResponse.json()) as {
        accountKeyRecovery: {
          accountKey: { publicKey: string };
          repairedEventCount: number;
          skipped: unknown[];
        };
      };
      expect(recovered.accountKeyRecovery.accountKey.publicKey).toBe(recoveryKey);
      expect(recovered.accountKeyRecovery.repairedEventCount).toBe(0);
      expect(recovered.accountKeyRecovery.skipped).toHaveLength(0);

      const readResponse = await app.handle(
        new Request(`http://pnlx.local/account-keys?ownerCommitment=${ownCommitment}`, {
          headers: authHeaders,
        }),
      );
      expect(readResponse.status).toBe(200);
      const read = (await readResponse.json()) as Record<string, Record<string, string>>;
      expect(read.accountKey.publicKey).toBe(recoveryKey);

      const foreignRead = await app.handle(
        new Request(`http://pnlx.local/account-keys?ownerCommitment=${otherCommitment}`, {
          headers: authHeaders,
        }),
      );
      expect(foreignRead.status).toBe(500);
      expect(await foreignRead.json()).toEqual({
        error: "ownerCommitment does not match authenticated account",
      });
    } finally {
      restoreEnv("AUTH_REQUIRED", previousRequired);
    }
  });

  test("uses runtime funding config for funding cycles", async () => {
    const previousEnabled = process.env.FUNDING_ENGINE_ENABLED;
    const previousInterval = process.env.FUNDING_INTERVAL_MS;
    const previousMaxDelta = process.env.FUNDING_MAX_DELTA;
    const previousPremium = process.env.FUNDING_PREMIUM_RATE;
    process.env.FUNDING_ENGINE_ENABLED = "false";
    process.env.FUNDING_INTERVAL_MS = String(60 * 60 * 1000);
    process.env.FUNDING_MAX_DELTA = "7";
    process.env.FUNDING_PREMIUM_RATE = "1000000";
    try {
      const app = createApp();
      const market = {
        marketId: "btc-usd-perp",
        oraclePrice: 50_000n * PRICE_SCALE,
        maxLeverage: 10n,
        initialMarginRate: 100_000n,
        maintenanceMarginRate: 50_000n,
        fundingIndex: 0n,
      };
      const marketResponse = await app.handle(
        new Request("http://pnlx.local/markets", {
          method: "POST",
          body: body(market),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(marketResponse.status).toBe(201);

      const fundingResponse = await app.handle(
        new Request("http://pnlx.local/funding/run", {
          method: "POST",
          body: body({
            appliedAt: "1000",
            elapsedMs: String(60 * 60 * 1000),
            marketId: market.marketId,
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(fundingResponse.status).toBe(201);
      const funding = (await fundingResponse.json()) as Record<string, Record<string, unknown>>;
      const rows = funding.fundingCycle.results as Record<string, Record<string, string>>[];
      expect(rows[0].update?.fundingDelta).toBe("7");
    } finally {
      restoreEnv("FUNDING_ENGINE_ENABLED", previousEnabled);
      restoreEnv("FUNDING_INTERVAL_MS", previousInterval);
      restoreEnv("FUNDING_MAX_DELTA", previousMaxDelta);
      restoreEnv("FUNDING_PREMIUM_RATE", previousPremium);
    }
  });

  test("binds account-sensitive mutations to the signed Stellar session", async () => {
    const previous = process.env.AUTH_REQUIRED;
    process.env.AUTH_REQUIRED = "true";
    try {
      const app = createApp();
      const { address, token } = await createSignedSession(app);
      const other = (await createSignedSession(app)).address;
      const authHeaders = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      };

      const ownNote = await depositCircuitMarginNote(app, {
        assetId: "usdc",
        amount: 12_000n,
        owner: address,
        spendSecret: "auth-own-spend",
        rho: "auth-own-rho",
        blinding: "auth-own-blind",
      }, authHeaders);
      const ownIntent = await proveAndSubmitIntentRequest(app, {
        batchId: "auth-batch",
        marketId: "btc-usd-perp",
        owner: address,
        side: "long",
        size: "1",
        limitPrice: (51_000n * PRICE_SCALE).toString(),
        margin: "12000",
        noteNullifier: ownNote.note.noteNullifier,
        nonce: "auth-own-intent",
        salt: "auth-own-salt",
      }, ownNote.note, ownNote.membershipProof, authHeaders);
      expect(ownIntent.status).toBe(201);
      const ownIntentBody = (await ownIntent.json()) as Record<string, Record<string, string>>;
      expect(ownIntentBody.intent.intentCommitment).toBe(ownIntentBody.validity.intentCommitment);
      expect(ownIntentBody.validity.noteNullifier).toBe(ownNote.note.noteNullifier);

      const foreignNote = await depositCircuitMarginNote(app, {
        assetId: "usdc",
        amount: 12_000n,
        owner: other,
        spendSecret: "auth-foreign-spend",
        rho: "auth-foreign-rho",
        blinding: "auth-foreign-blind",
      }, authHeaders);
      const foreignIntent = await proveAndSubmitIntentRequest(app, {
        batchId: "auth-batch",
        marketId: "btc-usd-perp",
        owner: other,
        side: "long",
        size: "1",
        limitPrice: (51_000n * PRICE_SCALE).toString(),
        margin: "12000",
        noteNullifier: foreignNote.note.noteNullifier,
        nonce: "auth-foreign-intent",
        salt: "auth-foreign-salt",
      }, foreignNote.note, foreignNote.membershipProof, authHeaders);
      expect(foreignIntent.status).toBe(500);
      expect(await foreignIntent.json()).toEqual({
        error: "owner does not match authenticated account",
      });

      const foreignDeposit = await app.handle(
        new Request("http://pnlx.local/notes/deposit-asset", {
          method: "POST",
          body: body({
            amount: "1000",
            commitment: hashFields("deposit", ["foreign-source"]),
            from: other,
            token: "CUSDC",
          }),
          headers: authHeaders,
        }),
      );
      expect(foreignDeposit.status).toBe(500);
      expect(await foreignDeposit.json()).toEqual({
        error: "from does not match authenticated account",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AUTH_REQUIRED;
      } else {
        process.env.AUTH_REQUIRED = previous;
      }
    }
  });

  test("rejects intents without current backed-margin validity", async () => {
    const app = createApp();
    const intent = {
      batchId: "stale-root-batch",
      marketId: "btc-usd-perp",
      owner: "alice",
      side: "long",
      size: "1",
      limitPrice: (51_000n * PRICE_SCALE).toString(),
      margin: "12000",
      noteNullifier: hashFields("stale-root-nullifier", ["alice"]),
      nonce: "stale-root-intent",
      salt: "stale-root-salt",
    };

    const missingValidity = await app.handle(
      new Request("http://pnlx.local/intents", {
        method: "POST",
        body: body(intent),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(missingValidity.status).toBe(500);

    const staleNote = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 12_000n,
      owner: "alice",
      spendSecret: "stale-root-spend",
      rho: "stale-root-rho",
      blinding: "stale-root-blind",
    });
    intent.noteNullifier = staleNote.note.noteNullifier;
    const staleValidity = await proveIntent(app, intent, staleNote.note, staleNote.membershipProof);
    const rootChangingNote = createCircuitMarginNote({
      assetId: "usdc",
      amount: 1n,
      owner: "root-change",
      spendSecret: "root-change-spend",
      rho: "root-change-rho",
      blinding: "root-change-blind",
    });
    await app.handle(
      new Request("http://pnlx.local/notes/deposit", {
        method: "POST",
        body: body({ commitment: rootChangingNote.commitment }),
        headers: { "content-type": "application/json" },
      }),
    );

    const staleRoot = await app.handle(
      new Request("http://pnlx.local/intents", {
        method: "POST",
        body: body({ ...intent, validity: staleValidity }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(staleRoot.status).toBe(500);
    expect(await staleRoot.json()).toEqual({
      error: "intent margin root is not current",
      });
  });

  test("rejects prove-and-submit private intents with stale margin roots", async () => {
    const app = createApp();
    const note = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 12_000n,
      owner: "alice",
      spendSecret: "prove-submit-stale-spend",
      rho: "prove-submit-stale-rho",
      blinding: "prove-submit-stale-blind",
    });
    const intent = {
      batchId: "prove-submit-stale-batch",
      marketId: "btc-usd-perp",
      owner: "alice",
      side: "long",
      size: "1",
      limitPrice: (51_000n * PRICE_SCALE).toString(),
      margin: "12000",
      noteNullifier: note.note.noteNullifier,
      nonce: "prove-submit-stale-intent",
      salt: "prove-submit-stale-salt",
    };

    const response = await proveAndSubmitIntentRequest(
      app,
      intent,
      note.note,
      {
        ...note.membershipProof,
        root: hashFields("stale-margin-root", ["prove-submit"]),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "intent margin root is not current",
    });
  });

  test("cancels and replaces live private orders through the API", async () => {
    const app = createApp();
    const post = async (path: string, data: unknown) => {
      const response = await app.handle(
        new Request(`http://pnlx.local${path}`, {
          method: "POST",
          body: body(data),
          headers: { "content-type": "application/json" },
        }),
      );
      if (response.status >= 300) {
        throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    };

    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 200_000n,
      maintenanceMarginRate: 100_000n,
      fundingIndex: 0n,
    };
    await post("/markets", market);

    const owner = "api-order-owner";
    const batchId = "api-order-replace-batch";
    const ownerNote = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 12_000n,
      owner,
      spendSecret: "api-order-owner-spend",
      rho: "api-order-owner-rho",
      blinding: "api-order-owner-blind",
    });
    const originalIntent = {
      batchId,
      marketId: market.marketId,
      owner,
      side: "long",
      size: "1",
      limitPrice: (51_000n * PRICE_SCALE).toString(),
      margin: "12000",
      noteNullifier: ownerNote.note.noteNullifier,
      nonce: "api-original-intent",
      salt: "api-original-salt",
    };
    const originalResponse = await submitIntentRequest(
      app,
      originalIntent,
      ownerNote.note,
      ownerNote.membershipProof,
    );
    expect(originalResponse.status).toBe(201);
    const originalRecord = (await originalResponse.json()) as Record<string, string>;

    const replacementIntent = {
      ...originalIntent,
      limitPrice: (52_000n * PRICE_SCALE).toString(),
      nonce: "api-replacement-intent",
      salt: "api-replacement-salt",
    };
    const replacementValidity = await proveIntent(
      app,
      replacementIntent,
      ownerNote.note,
      ownerNote.membershipProof,
    );
    const replaceResult = await post("/orders/replace", {
      intentCommitment: originalRecord.intentCommitment,
      replacement: {
        ...replacementIntent,
        validity: replacementValidity,
      },
    });
    expect((replaceResult.cancelledOrder as Record<string, string>).status).toBe("cancelled");

    const replacementCommitment = commitIntent({
      batchId,
      marketId: market.marketId,
      owner,
      side: "long",
      size: 1n,
      limitPrice: 52_000n * PRICE_SCALE,
      margin: 12_000n,
      noteNullifier: ownerNote.note.noteNullifier as Hex,
      nonce: "api-replacement-intent",
      salt: "api-replacement-salt",
    });
    expect((replaceResult.replacementIntent as Record<string, string>).intentCommitment).toBe(
      replacementCommitment,
    );

    const shortNote = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 12_000n,
      owner: "api-order-short",
      spendSecret: "api-order-short-spend",
      rho: "api-order-short-rho",
      blinding: "api-order-short-blind",
    });
    const shortIntent = {
      batchId,
      marketId: market.marketId,
      owner: "api-order-short",
      side: "short",
      size: "1",
      limitPrice: (49_000n * PRICE_SCALE).toString(),
      margin: "12000",
      noteNullifier: shortNote.note.noteNullifier,
      nonce: "api-short-intent",
      salt: "api-short-salt",
    };
    const shortResponse = await submitIntentRequest(app, shortIntent, shortNote.note, shortNote.membershipProof);
    expect(shortResponse.status).toBe(201);
    const shortRecord = (await shortResponse.json()) as Record<string, string>;

    const settlementResult = await post("/batches/settle", { batchId, marketId: market.marketId });
    const settlement = settlementResult.settlement as Record<string, unknown>;
    const orderUpdates = settlement.orderUpdates as Record<string, string>[];
    expect(orderUpdates.map((update) => update.intentCommitment)).toEqual([
      replacementCommitment,
      shortRecord.intentCommitment,
    ]);
    expect(orderUpdates.map((update) => update.intentCommitment)).not.toContain(
      originalRecord.intentCommitment,
    );

    const portfolioResponse = await app.handle(
      new Request(`http://pnlx.local/portfolio?ownerCommitment=${ownerCommitment(owner)}`),
    );
    expect(portfolioResponse.status).toBe(200);
    const portfolioResult = (await portfolioResponse.json()) as Record<string, Record<string, unknown>>;
    const orders = portfolioResult.portfolio.orders as Record<string, string>[];
    expect(orders.find((order) => order.intentCommitment === originalRecord.intentCommitment)?.status).toBe(
      "cancelled",
    );
    expect(orders.find((order) => order.intentCommitment === replacementCommitment)?.status).toBe(
      "filled",
    );

    const ordersResponse = await app.handle(
      new Request(`http://pnlx.local/portfolio/orders?ownerCommitment=${ownerCommitment(owner)}`),
    );
    expect(ordersResponse.status).toBe(200);
    const ordersResult = (await ordersResponse.json()) as Record<string, Record<string, string>[]>;
    expect(ordersResult.orders.find((order) => order.intentCommitment === replacementCommitment)?.status).toBe(
      "filled",
    );

    const positionsResponse = await app.handle(
      new Request(`http://pnlx.local/portfolio/positions?ownerCommitment=${ownerCommitment(owner)}`),
    );
    expect(positionsResponse.status).toBe(200);
    const positionsResult = (await positionsResponse.json()) as Record<string, Record<string, string>[]>;
    expect(positionsResult.positions).toHaveLength(1);
    expect(JSON.stringify(positionsResult)).not.toContain("positionNullifier");
  });

  test("submits private intents without plaintext response terms and settles them", async () => {
    const app = createApp();
    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 200_000n,
      maintenanceMarginRate: 100_000n,
      fundingIndex: 0n,
    };
    await app.handle(
      new Request("http://pnlx.local/markets", {
        method: "POST",
        body: body(market),
        headers: { "content-type": "application/json" },
      }),
    );

    const clientProver = new ProverService();
    const longNote = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 12_000n,
      owner: "shared-long-owner",
      spendSecret: "shared-long-spend",
      rho: "shared-long-rho",
      blinding: "shared-long-blind",
    });
    const shortNote = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 12_000n,
      owner: "shared-short-owner",
      spendSecret: "shared-short-spend",
      rho: "shared-short-rho",
      blinding: "shared-short-blind",
    });
    const sharedMarginLeaves = [
      longNote.note.commitment as Hex,
      shortNote.note.commitment as Hex,
    ];
    const longMembershipProof = fieldMerkleProof(
      sharedMarginLeaves,
      longNote.note.commitment as Hex,
    );
    const shortMembershipProof = fieldMerkleProof(
      sharedMarginLeaves,
      shortNote.note.commitment as Hex,
    );
    const batchId = "private-intent-batch";
    const long = buildPrivateIntent(clientProver, {
      batchId,
      limitPrice: 51_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: market.marketId,
      note: longNote.note,
      membershipProof: longMembershipProof,
      nonce: "shared-long-intent",
      owner: "shared-long-owner",
      salt: "shared-long-salt",
      side: "long",
      size: 1n,
    });
    const short = buildPrivateIntent(clientProver, {
      batchId,
      limitPrice: 49_000n * PRICE_SCALE,
      margin: 12_000n,
      marketId: market.marketId,
      note: shortNote.note,
      membershipProof: shortMembershipProof,
      nonce: "shared-short-intent",
      owner: "shared-short-owner",
      salt: "shared-short-salt",
      side: "short",
      size: 1n,
    });

    const longResponse = await app.handle(
      new Request("http://pnlx.local/intents", {
        method: "POST",
        body: body(long),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(longResponse.status).toBe(201);
    const longText = JSON.stringify(await longResponse.json());
    expect(longText).not.toContain("shared-long-owner");
    expect(longText).not.toContain("long");
    expect(longText).not.toContain((51_000n * PRICE_SCALE).toString());
    expect(longText).not.toContain("12000");

    const shortResponse = await app.handle(
      new Request("http://pnlx.local/intents", {
        method: "POST",
        body: body(short),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(shortResponse.status).toBe(201);

    const settlementResponse = await app.handle(
      new Request("http://pnlx.local/batches/settle", {
        method: "POST",
        body: body({ batchId, marketId: market.marketId }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(settlementResponse.status).toBeLessThan(300);
    const settlement = (await settlementResponse.json()) as Record<string, Record<string, unknown>>;
    expect(settlement.settlement.fillCount).toBe(2);
    expect(settlement.settlement.spentNullifiers).toContain(long.record.noteNullifier);
    expect(settlement.settlement.spentNullifiers).toContain(short.record.noteNullifier);

    const positionCommitments = settlement.settlement.newCommitments as Hex[];
    const longPosition = createSettledPositionWitness({
      allCommitments: positionCommitments,
      entryPrice: 51_000n * PRICE_SCALE,
      fillIndex: 0,
      fundingIndex: 0n,
      intent: long.intent,
      margin: 12_000n,
      owner: "shared-long-owner",
      side: "long",
      size: 1n,
    });
    const closeMarkPrice = 56_000n * PRICE_SCALE;
    const marketUpdateResponse = await app.handle(
      new Request("http://pnlx.local/markets/update", {
        method: "POST",
        body: body({ ...market, oraclePrice: closeMarkPrice }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(marketUpdateResponse.status).toBeLessThan(300);

    const trigger = {
      marketId: market.marketId,
      positionNullifier: longPosition.position.positionNullifier as Hex,
      side: "long" as const,
      kind: "take-profit" as const,
      triggerPrice: 55_000n * PRICE_SCALE,
      markPrice: closeMarkPrice,
      size: 1n,
      reduceOnly: true,
      salt: "shared-long-private-tp-salt",
    };
    const closeCommitment = commitConditionalOrder(trigger);
    const registerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders", {
        method: "POST",
        body: body({
          marketId: trigger.marketId,
          positionNullifier: trigger.positionNullifier,
          closeCommitment,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(registerResponse.status).toBeLessThan(300);

    const triggerProof = clientProver.proveConditionalClose(trigger);
    const triggerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders/trigger-proven", {
        method: "POST",
        body: body(triggerProof),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(triggerResponse.status).toBe(201);

    const closeSettlement = settleClose({
      side: "long",
      closeSize: 1n,
      entryPrice: 51_000n * PRICE_SCALE,
      markPrice: closeMarkPrice,
      margin: 12_000n,
      fundingPayment: 0n,
      fee: 10n,
    });
    const owner = ownerCommitment("shared-long-owner");
    const closedPosition = createCircuitPositionNote({
      marketId: market.marketId,
      side: "long",
      size: 0n,
      entryPrice: 51_000n * PRICE_SCALE,
      margin: 0n,
      fundingIndex: 0n,
      owner,
      spendSecret: "shared-long-closed-position-spend",
      rho: "shared-long-closed-position-rho",
      blinding: "shared-long-closed-position-blind",
    });
    const marginOutput = createCircuitMarginNote({
      assetId: "usdc",
      amount: closeSettlement.newMargin,
      owner,
      spendSecret: "shared-long-close-margin-spend",
      rho: "shared-long-close-margin-rho",
      blinding: "shared-long-close-margin-blind",
    });
    const provenClose = clientProver.provePositionClose({
      marketId: market.marketId,
      positionCommitment: longPosition.position.commitment as Hex,
      positionNullifier: longPosition.position.positionNullifier as Hex,
      positionRoot: longPosition.membershipProof.root as Hex,
      closeCommitment,
      side: "long",
      size: 1n,
      closeSize: 1n,
      entryPrice: 51_000n * PRICE_SCALE,
      markPrice: closeMarkPrice,
      margin: 12_000n,
      fundingIndex: 0n,
      fundingPayment: 0n,
      fee: 10n,
      newMargin: closeSettlement.newMargin,
      remainingMargin: 0n,
      marginOutputAmount: closeSettlement.newMargin,
      newPositionCommitment: closedPosition.commitment as Hex,
      newPositionRoot: fieldMerkleRoot([...positionCommitments, closedPosition.commitment as Hex]),
      marginOutputCommitment: marginOutput.commitment as Hex,
      marketDigest: longPosition.position.marketDigest,
      ownerDigest: longPosition.position.ownerDigest,
      rhoDigest: longPosition.position.rhoDigest,
      blinding: longPosition.position.blinding,
      spendSecretDigest: longPosition.position.spendSecretDigest,
      newPositionRhoDigest: closedPosition.rhoDigest,
      newPositionBlinding: closedPosition.blinding,
      marginOutputAssetDigest: marginOutput.assetDigest,
      marginOutputRhoDigest: marginOutput.rhoDigest,
      marginOutputBlinding: marginOutput.blinding,
      pathIndices: longPosition.membershipProof.indices as boolean[],
      pathSiblings: longPosition.membershipProof.siblings as Hex[],
    });
    const closeResponse = await app.handle(
      new Request("http://pnlx.local/position-closes/proven", {
        method: "POST",
        body: body(provenClose),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(closeResponse.status).toBe(201);
    const closeText = JSON.stringify(await closeResponse.json());
    expect(closeText).toContain(circuitKey("position-close"));
    expect(closeText).not.toContain("entryPrice");
    expect(closeText).not.toContain("shared-long-owner");
    expect(closeText).not.toContain(closeSettlement.newMargin.toString());
  });

  test("accepts manual proven position closes without a conditional trigger", async () => {
    const app = createApp();
    const clientProver = new ProverService();
    const suffix = "manual-close";
    const fixture = await createCloseableLongPositionFixture(app, clientProver, suffix);
    const closeSettlement = settleClose({
      side: "long",
      closeSize: 1n,
      entryPrice: 51_000n * PRICE_SCALE,
      markPrice: fixture.closeMarkPrice,
      margin: 12_000n,
      fundingPayment: 0n,
      fee: 10n,
    });
    const owner = ownerCommitment(`${suffix}-long-owner`);
    const accountKeyResponse = await app.handle(
      new Request("http://pnlx.local/account-keys", {
        method: "POST",
        body: body({
          algorithm: "ecdh-p256-aes-gcm",
          ownerCommitment: owner,
          publicKey: rawP256PublicKey(),
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(accountKeyResponse.status).toBe(201);
    const closedPosition = createCircuitPositionNote({
      marketId: fixture.market.marketId,
      side: "long",
      size: 0n,
      entryPrice: 51_000n * PRICE_SCALE,
      margin: 0n,
      fundingIndex: 0n,
      owner,
      spendSecret: `${suffix}-closed-position-spend`,
      rho: `${suffix}-closed-position-rho`,
      blinding: `${suffix}-closed-position-blind`,
    });
    const marginOutput = createCircuitMarginNote({
      assetId: "usdc",
      amount: closeSettlement.newMargin,
      owner,
      spendSecret: `${suffix}-close-margin-spend`,
      rho: `${suffix}-close-margin-rho`,
      blinding: `${suffix}-close-margin-blind`,
    });
    const closeCommitment = hashFields("manual-position-close", [suffix]);
    const provenClose = clientProver.provePositionClose({
      marketId: fixture.market.marketId,
      positionCommitment: fixture.longPosition.position.commitment as Hex,
      positionNullifier: fixture.longPosition.position.positionNullifier as Hex,
      positionRoot: fixture.longPosition.membershipProof.root as Hex,
      closeCommitment,
      side: "long",
      size: 1n,
      closeSize: 1n,
      entryPrice: 51_000n * PRICE_SCALE,
      markPrice: fixture.closeMarkPrice,
      margin: 12_000n,
      fundingIndex: 0n,
      fundingPayment: 0n,
      fee: 10n,
      newMargin: closeSettlement.newMargin,
      remainingMargin: 0n,
      marginOutputAmount: closeSettlement.newMargin,
      newPositionCommitment: closedPosition.commitment as Hex,
      newPositionRoot: fieldMerkleRoot([
        ...fixture.positionCommitments,
        closedPosition.commitment as Hex,
      ]),
      marginOutputCommitment: marginOutput.commitment as Hex,
      marketDigest: fixture.longPosition.position.marketDigest,
      ownerDigest: fixture.longPosition.position.ownerDigest,
      rhoDigest: fixture.longPosition.position.rhoDigest,
      blinding: fixture.longPosition.position.blinding,
      spendSecretDigest: fixture.longPosition.position.spendSecretDigest,
      newPositionRhoDigest: closedPosition.rhoDigest,
      newPositionBlinding: closedPosition.blinding,
      marginOutputAssetDigest: marginOutput.assetDigest,
      marginOutputRhoDigest: marginOutput.rhoDigest,
      marginOutputBlinding: marginOutput.blinding,
      pathIndices: fixture.longPosition.membershipProof.indices as boolean[],
      pathSiblings: fixture.longPosition.membershipProof.siblings as Hex[],
    });

    const conditionalResponse = await app.handle(
      new Request("http://pnlx.local/position-closes/proven", {
        method: "POST",
        body: body(provenClose),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(conditionalResponse.status).toBe(500);
    expect(await conditionalResponse.json()).toEqual({ error: "conditional close not triggered" });

    const manualResponse = await app.handle(
      new Request("http://pnlx.local/position-closes/manual-proven", {
        method: "POST",
        body: body(provenClose),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(manualResponse.status).toBe(201);
    const manualText = JSON.stringify(await manualResponse.json());
    expect(manualText).toContain(circuitKey("position-close"));
    expect(manualText).not.toContain(`${suffix}-long-owner`);
    expect(manualText).not.toContain(closeSettlement.newMargin.toString());

    const eventsResponse = await app.handle(
      new Request(`http://pnlx.local/account-events?ownerCommitment=${owner}`),
    );
    expect(eventsResponse.status).toBe(200);
    const eventsResult = (await eventsResponse.json()) as Record<string, unknown>;
    const accountEvents = eventsResult.accountEvents as Record<string, string>[];
    expect(accountEvents).toHaveLength(1);
    expect(accountEvents[0].ciphertext.startsWith("pnlx-account-event-v1:")).toBe(true);
    expect(JSON.stringify(accountEvents)).not.toContain(`${suffix}-long-owner`);
    expect(JSON.stringify(accountEvents)).not.toContain(closeSettlement.newMargin.toString());
  });

  test("executes queued proven liquidations and emits encrypted account events", async () => {
    const app = createApp();
    const clientProver = new ProverService();
    const suffix = "liquidation-automation";
    const fixture = await createCloseableLongPositionFixture(app, clientProver, suffix);
    const owner = ownerCommitment(`${suffix}-long-owner`);
    const accountKeyResponse = await app.handle(
      new Request("http://pnlx.local/account-keys", {
        method: "POST",
        body: body({
          algorithm: "ecdh-p256-aes-gcm",
          ownerCommitment: owner,
          publicKey: rawP256PublicKey(),
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(accountKeyResponse.status).toBe(201);

    const liquidationMarkPrice = 40_000n * PRICE_SCALE;
    const marketUpdateResponse = await app.handle(
      new Request("http://pnlx.local/markets/update", {
        method: "POST",
        body: body({ ...fixture.market, oraclePrice: liquidationMarkPrice }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(marketUpdateResponse.status).toBeLessThan(300);

    const provenLiquidation = clientProver.proveLiquidation({
      marketId: fixture.market.marketId,
      positionCommitment: fixture.longPosition.position.commitment as Hex,
      positionNullifier: fixture.longPosition.position.positionNullifier as Hex,
      positionRoot: fixture.longPosition.membershipProof.root as Hex,
      rewardCommitment: hashFields("reward", [suffix]),
      side: "long",
      size: 1n,
      entryPrice: 51_000n * PRICE_SCALE,
      markPrice: liquidationMarkPrice,
      margin: 12_000n,
      fundingPayment: 0n,
      fundingIndex: 0n,
      maintenanceRate: fixture.market.maintenanceMarginRate,
      marketDigest: fixture.longPosition.position.marketDigest,
      ownerDigest: fixture.longPosition.position.ownerDigest,
      rhoDigest: fixture.longPosition.position.rhoDigest,
      blinding: fixture.longPosition.position.blinding,
      spendSecretDigest: fixture.longPosition.position.spendSecretDigest,
      pathIndices: fixture.longPosition.membershipProof.indices as boolean[],
      pathSiblings: fixture.longPosition.membershipProof.siblings as Hex[],
    });

    const enqueueResponse = await app.handle(
      new Request("http://pnlx.local/liquidation-automation/jobs", {
        method: "POST",
        body: body({ liquidation: provenLiquidation }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(enqueueResponse.status).toBe(201);

    const runResponse = await app.handle(
      new Request("http://pnlx.local/liquidation-automation/run", {
        method: "POST",
        body: body({ marketId: fixture.market.marketId }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(runResponse.status).toBe(201);
    const run = (await runResponse.json()) as Record<string, unknown>;
    const jobs = run.jobs as Array<{ job: Record<string, unknown>; status: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("executed");
    expect((jobs[0].job as Record<string, unknown>).status).toBe("executed");

    const eventsResponse = await app.handle(
      new Request(`http://pnlx.local/account-events?ownerCommitment=${owner}`),
    );
    expect(eventsResponse.status).toBe(200);
    const eventsResult = (await eventsResponse.json()) as Record<string, unknown>;
    const accountEvents = eventsResult.accountEvents as Record<string, string>[];
    expect(accountEvents).toHaveLength(1);
    expect(accountEvents[0].ciphertext.startsWith("pnlx-account-event-v1:")).toBe(true);
    expect(JSON.stringify(accountEvents)).not.toContain(`${suffix}-long-owner`);
    expect(JSON.stringify(accountEvents)).not.toContain("entryPrice");
  });

  test("creates privacy-preserving proof records", async () => {
    const app = createApp();
    const clientProver = new ProverService();
    const post = async (path: string, data: unknown) => {
      const response = await app.handle(
        new Request(`http://pnlx.local${path}`, {
          method: "POST",
          body: body(data),
          headers: { "content-type": "application/json" },
        }),
      );
      if (response.status >= 300) {
        throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
      }
      return (await response.json()) as Record<string, unknown>;
    };

    const market = {
      marketId: "btc-usd-perp",
      oraclePrice: 50_000n * PRICE_SCALE,
      maxLeverage: 5n,
      initialMarginRate: 200_000n,
      maintenanceMarginRate: 100_000n,
      fundingIndex: 0n,
    };
    await post("/markets", market);
    const fundingUpdate = await post("/funding/advance", {
      fundingDelta: "150",
      marketId: market.marketId,
    });
    expect((fundingUpdate.fundingUpdate as Record<string, string>).oldFundingIndex).toBe("0");
    expect((fundingUpdate.fundingUpdate as Record<string, string>).newFundingIndex).toBe("150");
    const fundingCycle = await post("/funding/run", {
      appliedAt: "100000",
      elapsedMs: String(60 * 60 * 1000),
      marketId: market.marketId,
      maxFundingDelta: "10",
      premiumRate: "100",
    });
    const fundingCycleResult = fundingCycle.fundingCycle as Record<string, unknown>;
    const fundingCycleRows = fundingCycleResult.results as Record<string, unknown>[];
    expect(fundingCycleRows[0].skipped).toBe(false);
    const fundingEngineUpdate = fundingCycleRows[0].update as Record<string, string>;
    expect(fundingEngineUpdate.oldFundingIndex).toBe("150");
    expect(fundingEngineUpdate.newFundingIndex).toBe("155");

    const withdrawalNote = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 20_000n,
      owner: "alice",
      spendSecret: "alice-withdraw-spend",
      rho: "alice-withdraw-rho",
      blinding: "alice-withdraw-blind",
    });
    const provenWithdrawal = clientProver.proveWithdrawal({
      assetDigest: withdrawalNote.note.assetDigest,
      blinding: withdrawalNote.note.blinding,
      changeBlinding: hashFields("change-blinding", ["alice-exit"]),
      changeRhoDigest: hashFields("change-rho", ["alice-exit"]),
      noteAmount: 20_000n,
      noteCommitment: withdrawalNote.note.commitment,
      withdrawAmount: 5_000n,
      ownerDigest: withdrawalNote.note.ownerDigest,
      pathIndices: withdrawalNote.membershipProof.indices,
      pathSiblings: withdrawalNote.membershipProof.siblings,
      root: withdrawalNote.membershipProof.root,
      rhoDigest: withdrawalNote.note.rhoDigest,
      nullifier: withdrawalNote.note.noteNullifier,
      recipient: hashFields("recipient", ["alice-exit"]),
      spendSecretDigest: withdrawalNote.note.spendSecretDigest,
      tokenDigest: withdrawalNote.note.assetDigest,
    });
    const withdrawal = await post("/notes/withdraw/proven", provenWithdrawal);
    const withdrawalText = JSON.stringify(withdrawal);
    expect(withdrawalText).toContain("proofDigest");
    expect(withdrawalText).toContain("proofHash");
    expect(withdrawalText).toContain(circuitKey("withdraw"));
    const withdrawalResponseRecord = withdrawal.withdrawal as Record<string, unknown>;
    const withdrawalProof = withdrawalResponseRecord.proof as Record<string, string>;
    expect(withdrawalProof.verifierHash).toBe(withdrawalProof.vkHash);
    expect(JSON.stringify(withdrawal)).not.toContain("alice-withdraw-spend");

    const aliceIntentNote = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 12_000n,
      owner: "alice",
      spendSecret: "alice-intent-spend",
      rho: "alice-intent-rho",
      blinding: "alice-intent-blind",
    });

    const intent = {
      batchId: "api-batch-1",
      marketId: market.marketId,
      owner: "alice",
      side: "long",
      size: "1",
      limitPrice: (51_000n * PRICE_SCALE).toString(),
      margin: "12000",
      noteNullifier: aliceIntentNote.note.noteNullifier,
      nonce: "api-intent-1",
      salt: "api-intent-salt",
    };
    const aliceIntentResponse = await submitIntentRequest(
      app,
      intent,
      aliceIntentNote.note,
      aliceIntentNote.membershipProof,
    );
    expect(aliceIntentResponse.status).toBeLessThan(300);
    const bobIntentNote = await depositCircuitMarginNote(app, {
      assetId: "usdc",
      amount: 12_000n,
      owner: "bob",
      spendSecret: "bob-intent-spend",
      rho: "bob-intent-rho",
      blinding: "bob-intent-blind",
    });
    const bobIntent = {
      ...intent,
      owner: "bob",
      side: "short",
      limitPrice: (49_000n * PRICE_SCALE).toString(),
      noteNullifier: bobIntentNote.note.noteNullifier,
      nonce: "api-intent-2",
      salt: "api-intent-bob-salt",
    };
    const aliceTradeIntent = tradeIntentFromBody(intent);
    const bobTradeIntent = tradeIntentFromBody(bobIntent);
    const bobIntentResponse = await submitIntentRequest(
      app,
      bobIntent,
      bobIntentNote.note,
      bobIntentNote.membershipProof,
    );
    expect(bobIntentResponse.status).toBeLessThan(300);

    const settlementResult = await post("/batches/settle", {
      batchId: "api-batch-1",
      marketId: market.marketId,
    });
    const settlementRecord = settlementResult.settlement as Record<string, unknown>;
    const positionCommitments = settlementRecord.newCommitments as Hex[];
    const settlementText = JSON.stringify(settlementResult);
    expect(settlementText).not.toContain("long");
    expect(settlementText).not.toContain("alice");
    expect(settlementText).toContain("newCommitments");
    expect(settlementRecord.proof).toEqual(expect.objectContaining({
      circuitKey: RISC0_BATCH_MATCH_CIRCUIT_KEY,
      proofSystem: "risc0-groth16",
    }));
    expect(settlementRecord.proof).toHaveProperty("imageId");
    expect(settlementRecord.proof).toHaveProperty("journalDigest");
    expect(settlementRecord.proof).toHaveProperty("sealDigest");

    const alicePosition = createSettledPositionWitness({
      allCommitments: positionCommitments,
	      entryPrice: 51_000n * PRICE_SCALE,
	      fillIndex: 0,
	      fundingIndex: 155n,
	      intent: aliceTradeIntent,
      margin: 12_000n,
      owner: "alice",
      side: "long",
      size: 1n,
    });
    const bobPosition = createSettledPositionWitness({
      allCommitments: positionCommitments,
	      entryPrice: 51_000n * PRICE_SCALE,
	      fillIndex: 1,
	      fundingIndex: 155n,
	      intent: bobTradeIntent,
      margin: 12_000n,
      owner: "bob",
      side: "short",
      size: 1n,
    });
    const liquidationMarket = {
      ...market,
      oraclePrice: 60_000n * PRICE_SCALE,
      fundingIndex: 155n,
    };
    await post("/markets/update", liquidationMarket);

    const provenLiquidation = clientProver.proveLiquidation({
      marketId: market.marketId,
      positionCommitment: bobPosition.position.commitment,
      positionNullifier: bobPosition.position.positionNullifier,
      positionRoot: bobPosition.membershipProof.root,
      rewardCommitment: hashFields("reward", ["liquidator"]),
      side: "short",
      size: 1n,
      entryPrice: 51_000n * PRICE_SCALE,
      markPrice: 60_000n * PRICE_SCALE,
      margin: 12_000n,
      fundingPayment: 0n,
      fundingIndex: 155n,
      maintenanceRate: 100_000n,
      marketDigest: bobPosition.position.marketDigest,
      ownerDigest: bobPosition.position.ownerDigest,
      rhoDigest: bobPosition.position.rhoDigest,
      blinding: bobPosition.position.blinding,
      spendSecretDigest: bobPosition.position.spendSecretDigest,
      pathIndices: bobPosition.membershipProof.indices,
      pathSiblings: bobPosition.membershipProof.siblings,
    });
    const liquidation = await post("/liquidations/proven", provenLiquidation);
    const liquidationText = JSON.stringify(liquidation);
    expect(liquidationText).toContain("proofDigest");
    expect(liquidationText).toContain("proofHash");
    expect(liquidationText).toContain(circuitKey("liquidation-check"));
    const liquidationRecord = liquidation.liquidation as Record<string, unknown>;
    const liquidationProof = liquidationRecord.proof as Record<string, string>;
    expect(liquidationProof.verifierHash).toBe(liquidationProof.vkHash);
    expect(JSON.stringify(liquidation)).not.toContain("entryPrice");

    const triggeredMarket = {
      ...liquidationMarket,
      oraclePrice: 56_000n * PRICE_SCALE,
    };
    await post("/markets/update", triggeredMarket);
    const conditionalOrderWitness = {
      marketId: market.marketId,
      positionNullifier: alicePosition.position.positionNullifier,
      side: "long",
      kind: "take-profit",
      triggerPrice: (55_000n * PRICE_SCALE).toString(),
      markPrice: (56_000n * PRICE_SCALE).toString(),
      size: "1",
      reduceOnly: "true",
      salt: "alice-private-tp-salt",
    };
    const closeCommitment = commitConditionalOrder({
      ...conditionalOrderWitness,
      side: "long",
      kind: "take-profit",
      triggerPrice: BigInt(conditionalOrderWitness.triggerPrice),
      markPrice: BigInt(conditionalOrderWitness.markPrice),
      size: BigInt(conditionalOrderWitness.size),
      reduceOnly: true,
    });
    const conditionalOrder = await post("/conditional-orders", {
      marketId: conditionalOrderWitness.marketId,
      positionNullifier: conditionalOrderWitness.positionNullifier,
      closeCommitment,
    });
    const conditionalOrderText = JSON.stringify(conditionalOrder);
    expect(conditionalOrderText).toContain(closeCommitment);
    expect(conditionalOrderText).not.toContain("triggerPrice");
    expect(conditionalOrderText).not.toContain("take-profit");

    const conditionalClose = await post("/conditional-orders/trigger", conditionalOrderWitness);
    const conditionalCloseText = JSON.stringify(conditionalClose);
    expect(conditionalCloseText).toContain("closeCommitment");
    expect(conditionalCloseText).toContain("proofDigest");
    expect(conditionalCloseText).toContain("proofHash");
    expect(conditionalCloseText).toContain(circuitKey("conditional-close"));
    const conditionalCloseRecord = conditionalClose.conditionalClose as Record<string, unknown>;
    const conditionalCloseProof = conditionalCloseRecord.proof as Record<string, string>;
    expect(conditionalCloseProof.verifierHash).toBe(conditionalCloseProof.vkHash);
    expect(conditionalCloseText).not.toContain("triggerPrice");
    expect(conditionalCloseText).not.toContain("take-profit");
    expect(conditionalCloseText).not.toContain("alice-private-tp-salt");

    const closeSettlement = settleClose({
      side: "long",
      closeSize: 1n,
      entryPrice: 51_000n * PRICE_SCALE,
      markPrice: 56_000n * PRICE_SCALE,
      margin: 12_000n,
      fundingPayment: 0n,
      fee: 10n,
    });
    expect(closeSettlement.realizedPnl).toBe(5_000n);
    expect(closeSettlement.newMargin).toBe(16_990n);
    const aliceOwner = ownerCommitment("alice");
    const closedPosition = createCircuitPositionNote({
      marketId: market.marketId,
      side: "long",
      size: 0n,
      entryPrice: 51_000n * PRICE_SCALE,
      margin: 0n,
      fundingIndex: 155n,
      owner: aliceOwner,
      spendSecret: "alice-closed-position-spend",
      rho: "alice-closed-position-rho",
      blinding: "alice-closed-position-blind",
    });
    const marginOutput = createCircuitMarginNote({
      assetId: "usdc",
      amount: closeSettlement.newMargin,
      owner: aliceOwner,
      spendSecret: "alice-close-margin-spend",
      rho: "alice-close-margin-rho",
      blinding: "alice-close-margin-blind",
    });

    const positionClose = await post("/position-closes", {
      marketId: market.marketId,
      positionCommitment: alicePosition.position.commitment,
      positionNullifier: alicePosition.position.positionNullifier,
      positionRoot: alicePosition.membershipProof.root,
      closeCommitment,
      side: "long",
      size: "1",
      closeSize: "1",
      entryPrice: (51_000n * PRICE_SCALE).toString(),
      markPrice: (56_000n * PRICE_SCALE).toString(),
      margin: "12000",
      fundingIndex: "155",
      fundingPayment: "0",
      fee: "10",
      newMargin: closeSettlement.newMargin.toString(),
      remainingMargin: "0",
      marginOutputAmount: closeSettlement.newMargin.toString(),
      newPositionCommitment: closedPosition.commitment,
      newPositionRoot: fieldMerkleRoot([
        ...positionCommitments,
        closedPosition.commitment as Hex,
      ]),
      marginOutputCommitment: marginOutput.commitment,
      marketDigest: alicePosition.position.marketDigest,
      ownerDigest: alicePosition.position.ownerDigest,
      rhoDigest: alicePosition.position.rhoDigest,
      blinding: alicePosition.position.blinding,
      spendSecretDigest: alicePosition.position.spendSecretDigest,
      newPositionRhoDigest: closedPosition.rhoDigest,
      newPositionBlinding: closedPosition.blinding,
      marginOutputAssetDigest: marginOutput.assetDigest,
      marginOutputRhoDigest: marginOutput.rhoDigest,
      marginOutputBlinding: marginOutput.blinding,
      pathIndices: alicePosition.membershipProof.indices,
      pathSiblings: alicePosition.membershipProof.siblings,
    });
    const positionCloseText = JSON.stringify(positionClose);
    expect(positionCloseText).toContain("newPositionCommitment");
    expect(positionCloseText).toContain("marginOutputCommitment");
    expect(positionCloseText).toContain(circuitKey("position-close"));
    const positionCloseRecord = positionClose.positionClose as Record<string, unknown>;
    const positionCloseProof = positionCloseRecord.proof as Record<string, string>;
    expect(positionCloseProof.verifierHash).toBe(positionCloseProof.vkHash);
    expect(positionCloseText).not.toContain("entryPrice");
    expect(positionCloseText).not.toContain("realizedPnl");
    expect(positionCloseText).not.toContain("16990");

    const disclosureSubject = hashFields("subject", ["alice"]);
    const disclosureClaim = "margin-ratio-above-threshold";
    const disclosureWitness = createDisclosureWitness({
      claim: disclosureClaim,
      salt: "disclosure-salt",
      subject: disclosureSubject,
      value: 50n,
    });
    const provenDisclosure = clientProver.proveDisclosure({
      subject: disclosureSubject,
      claim: disclosureClaim,
      root: disclosureWitness.root,
      salt: "disclosure-salt",
      saltDigest: disclosureWitness.saltDigest,
      value: 50n,
      threshold: 100n,
      pathIndices: disclosureWitness.pathIndices,
      pathSiblings: disclosureWitness.pathSiblings,
    });
    const disclosure = await post("/disclosures/proven", provenDisclosure);
    const disclosureText = JSON.stringify(disclosure);
    expect(disclosureText).toContain("claimDigest");
    expect(disclosureText).toContain(circuitKey("disclosure"));
    const disclosureRecord = disclosure.disclosure as Record<string, unknown>;
    const disclosureProof = disclosureRecord.proof as Record<string, string>;
    expect(disclosureProof.verifierHash).toBe(disclosureProof.vkHash);
    expect(disclosureText).toContain("proofHash");
    expect(JSON.stringify(disclosure)).not.toContain("margin-ratio-above-threshold");
  });

  test("rejects disclosure threshold breaches", async () => {
    const app = createApp();
    const subject = hashFields("subject", ["alice"]);
    const claim = "margin-ratio-above-threshold";
    const witness = createDisclosureWitness({
      claim,
      salt: "bad-disclosure-salt",
      subject,
      value: 150n,
    });
    const response = await app.handle(
      new Request("http://pnlx.local/disclosures", {
        method: "POST",
        body: body({
          subject,
          claim,
          root: witness.root,
          salt: "bad-disclosure-salt",
          saltDigest: witness.saltDigest,
          value: "150",
          threshold: "100",
          pathIndices: witness.pathIndices,
          pathSiblings: witness.pathSiblings,
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(500);
  });

  test("rejects untriggered conditional closes", async () => {
    const app = createApp();
    const witness = {
      marketId: "btc-usd-perp",
      positionNullifier: hashFields("position-nullifier", ["alice", "untriggered"]),
      side: "long",
      kind: "take-profit",
      triggerPrice: (55_000n * PRICE_SCALE).toString(),
      markPrice: (54_000n * PRICE_SCALE).toString(),
      size: "1",
      reduceOnly: "true",
      salt: "alice-untriggered-tp-salt",
    };
    const marketResponse = await app.handle(
      new Request("http://pnlx.local/markets", {
        method: "POST",
        body: body({
          marketId: witness.marketId,
          oraclePrice: witness.markPrice,
          maxLeverage: 10n,
          initialMarginRate: 100_000n,
          maintenanceMarginRate: 50_000n,
          fundingIndex: 0n,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(marketResponse.status).toBeLessThan(300);
    const closeCommitment = commitConditionalOrder({
      ...witness,
      side: "long",
      kind: "take-profit",
      triggerPrice: BigInt(witness.triggerPrice),
      markPrice: BigInt(witness.markPrice),
      size: BigInt(witness.size),
      reduceOnly: true,
    });
    const registerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders", {
        method: "POST",
        body: body({
          marketId: witness.marketId,
          positionNullifier: witness.positionNullifier,
          closeCommitment,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(registerResponse.status).toBeLessThan(300);

    const response = await app.handle(
      new Request("http://pnlx.local/conditional-orders/trigger", {
        method: "POST",
        body: body(witness),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "conditional close not triggered" });
  });

  test("accepts client-proved conditional triggers without strategy preimage", async () => {
    const app = createApp();
    const marketId = "btc-usd-perp";
    const positionNullifier = hashFields("position-nullifier", ["alice", "client-proved-tp"]);
    const markPrice = 56_000n * PRICE_SCALE;
    const trigger = {
      marketId,
      positionNullifier,
      side: "long" as const,
      kind: "take-profit" as const,
      triggerPrice: 55_000n * PRICE_SCALE,
      markPrice,
      size: 1n,
      reduceOnly: true,
      salt: "client-private-tp-salt",
    };
    const closeCommitment = commitConditionalOrder(trigger);
    const clientProver = new ProverService();
    const provenTrigger = clientProver.proveConditionalClose(trigger);

    const marketResponse = await app.handle(
      new Request("http://pnlx.local/markets", {
        method: "POST",
        body: body({
          fundingIndex: "0",
          initialMarginRate: "100000",
          maintenanceMarginRate: "50000",
          marketId,
          maxLeverage: "10",
          oraclePrice: markPrice.toString(),
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(marketResponse.status).toBeLessThan(300);

    const registerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders", {
        method: "POST",
        body: body({
          marketId,
          positionNullifier,
          closeCommitment,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(registerResponse.status).toBeLessThan(300);

    const triggerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders/trigger-proven", {
        method: "POST",
        body: body(provenTrigger),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(triggerResponse.status).toBe(201);
    const triggerText = JSON.stringify(await triggerResponse.json());
    expect(triggerText).toContain(closeCommitment);
    expect(triggerText).toContain(circuitKey("conditional-close"));
    expect(triggerText).not.toContain("triggerPrice");
    expect(triggerText).not.toContain("take-profit");
    expect(triggerText).not.toContain("client-private-tp-salt");
    expect(triggerText).not.toContain((55_000n * PRICE_SCALE).toString());
  });

  test("rejects tampered client-proved conditional trigger public inputs", async () => {
    const app = createApp();
    const marketId = "btc-usd-perp";
    const positionNullifier = hashFields("position-nullifier", ["alice", "tampered-client-proved-tp"]);
    const originalMarkPrice = 56_000n * PRICE_SCALE;
    const tamperedMarkPrice = 57_000n * PRICE_SCALE;
    const trigger = {
      marketId,
      positionNullifier,
      side: "long" as const,
      kind: "take-profit" as const,
      triggerPrice: 55_000n * PRICE_SCALE,
      markPrice: originalMarkPrice,
      size: 1n,
      reduceOnly: true,
      salt: "tampered-client-private-tp-salt",
    };
    const closeCommitment = commitConditionalOrder(trigger);
    const clientProver = new ProverService();
    const provenTrigger = clientProver.proveConditionalClose(trigger);

    const marketResponse = await app.handle(
      new Request("http://pnlx.local/markets", {
        method: "POST",
        body: body({
          fundingIndex: "0",
          initialMarginRate: "100000",
          maintenanceMarginRate: "50000",
          marketId,
          maxLeverage: "10",
          oraclePrice: tamperedMarkPrice.toString(),
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(marketResponse.status).toBeLessThan(300);

    const registerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders", {
        method: "POST",
        body: body({
          marketId,
          positionNullifier,
          closeCommitment,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(registerResponse.status).toBeLessThan(300);

    const triggerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders/trigger-proven", {
        method: "POST",
        body: body({
          ...provenTrigger,
          markPrice: tamperedMarkPrice,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(triggerResponse.status).toBe(500);
    expect(await triggerResponse.json()).toEqual({ error: "proof public input mismatch" });
  });

  test("rejects position closes before trigger proof", async () => {
    const app = createApp();
    const response = await app.handle(
      new Request("http://pnlx.local/position-closes", {
        method: "POST",
        body: body({
          marketId: "btc-usd-perp",
          positionNullifier: hashFields("position-nullifier", ["alice", "untriggered-close"]),
          closeCommitment: hashFields("close", ["untriggered"]),
          side: "long",
          size: "1",
          closeSize: "1",
          entryPrice: (50_000n * PRICE_SCALE).toString(),
          markPrice: (56_000n * PRICE_SCALE).toString(),
          margin: "12000",
          fundingPayment: "0",
          fee: "10",
          newMargin: "17990",
          newPositionCommitment: hashFields("new-position", ["untriggered"]),
          marginOutputCommitment: hashFields("margin-output", ["untriggered"]),
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(500);
  });

  test("rejects position closes with a trigger for another position", async () => {
    const app = createApp();
    const triggeredNullifier = hashFields("position-nullifier", ["alice", "triggered"]);
    const settlingNullifier = hashFields("position-nullifier", ["alice", "different"]);
    const witness = {
      marketId: "btc-usd-perp",
      positionNullifier: triggeredNullifier,
      side: "long",
      kind: "take-profit",
      triggerPrice: (55_000n * PRICE_SCALE).toString(),
      markPrice: (56_000n * PRICE_SCALE).toString(),
      size: "1",
      reduceOnly: "true",
      salt: "alice-triggered-tp-salt",
    };
    const marketResponse = await app.handle(
      new Request("http://pnlx.local/markets", {
        method: "POST",
        body: body({
          marketId: witness.marketId,
          oraclePrice: witness.markPrice,
          maxLeverage: 10n,
          initialMarginRate: 100_000n,
          maintenanceMarginRate: 50_000n,
          fundingIndex: 0n,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(marketResponse.status).toBeLessThan(300);
    const closeCommitment = commitConditionalOrder({
      ...witness,
      side: "long",
      kind: "take-profit",
      triggerPrice: BigInt(witness.triggerPrice),
      markPrice: BigInt(witness.markPrice),
      size: BigInt(witness.size),
      reduceOnly: true,
    });

    const registerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders", {
        method: "POST",
        body: body({
          marketId: witness.marketId,
          positionNullifier: witness.positionNullifier,
          closeCommitment,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(registerResponse.status).toBeLessThan(300);

    const triggerResponse = await app.handle(
      new Request("http://pnlx.local/conditional-orders/trigger", {
        method: "POST",
        body: body(witness),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(triggerResponse.status).toBeLessThan(300);

    const response = await app.handle(
      new Request("http://pnlx.local/position-closes", {
        method: "POST",
        body: body({
          marketId: witness.marketId,
          positionNullifier: settlingNullifier,
          closeCommitment,
          side: "long",
          size: "1",
          closeSize: "1",
          entryPrice: (50_000n * PRICE_SCALE).toString(),
          markPrice: (56_000n * PRICE_SCALE).toString(),
          margin: "12000",
          fundingPayment: "0",
          fee: "10",
          newMargin: "17990",
          newPositionCommitment: hashFields("new-position", ["mismatched"]),
          marginOutputCommitment: hashFields("margin-output", ["mismatched"]),
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(500);
  });
});

function createFileExecutor(storePath: string): ExecutorService {
  return new ExecutorService({}, new FileProtocolStore(storePath));
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
        newRoot: input.newRoot,
        oldRoot: input.oldRoot,
        openInterestDelta: input.match.openInterestDelta,
        orderUpdates: input.match.orderUpdates,
        residualSize: input.match.residualSize,
        settlementDigest: hashFields("test-settlement", [input.batchId, input.newRoot]),
        spentNullifiers: input.match.spentNullifiers,
      };
      const publicInputHash = batchSettlementPublicInputHash({
        ...draft,
        proof: proofMeta("batch-match"),
      });
      const sealDigest = hashFields("risc0-seal", [input.batchId, input.newRoot]);
      return {
        ...draft,
        proof: {
          ...proofMeta("batch-match"),
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

function proofMeta(label: string): ProofMeta {
  return {
    circuitHash: hashFields("circuit-hash", [label]),
    circuitId: label,
    circuitKey: hashFields("circuit-key", [label]),
    proofDigest: hashFields("proof-digest", [label]),
    publicInputHash: hashFields("public-input", [label]),
    verifierHash: hashFields("verifier", [label]),
  };
}
