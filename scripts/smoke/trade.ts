import { spawnSync } from "node:child_process";
import { createECDH, createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import {
  commitConditionalOrder,
  hashFields,
  ownerCommitment,
} from "@pnlx/crypto";
import { PRICE_SCALE, settleClose } from "@pnlx/market-math";
import { createCircuitMarginNote, createCircuitPositionNote } from "@pnlx/sdk";
import type {
  ConditionalOrderRecord,
  ConditionalOrderWitness,
  Hex,
  IntentRecord,
  IntentValidityRecord,
  PositionCloseRecord,
  ProofMeta,
  TradeIntent,
} from "@pnlx/protocol-types";
import { createAppRuntimeAsync } from "@/app";
import { getSupportedPerpAsset, type SupportedPerpAsset } from "@/config/assets";
import { loadEnv } from "@/config/env";
import { stellarSignedMessageHash } from "@/features/auth/auth.service";
import { ProverService } from "@/workers/prover/prover.service";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_SECRET_KEY_VERSION = 18 << 3;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

interface Deployment {
  contracts: Record<string, string>;
  network: string;
  source: string;
  sourceAddress: string;
  verifiers: Record<string, string>;
}

interface MarketSmokeContext {
  aliceRecord: IntentRecord;
  asset: SupportedPerpAsset;
  batchId: string;
  bobRecord: IntentRecord;
  close: CloseSmokeResult;
  marketId: string;
  oraclePrice: bigint;
  oraclePublishTime: number;
  settlement: Record<string, unknown>;
}

interface CloseSmokeResult {
  closeCommitment: Hex;
  conditionalClose: ConditionalOrderRecord;
  markPrice: bigint;
  newMargin: bigint;
  newPositionCommitment: Hex;
  positionClose: PositionCloseRecord;
  positionNullifier: Hex;
  realizedPnl: bigint;
  triggerPrice: bigint;
}

type CircuitMarginNote = ReturnType<typeof createCircuitMarginNote>;
type MarginMembershipProof = {
  indices: boolean[];
  root: Hex;
  siblings: Hex[];
};
type OraclePublishContext = Pick<MarketSmokeContext, "asset" | "oraclePrice" | "oraclePublishTime">;
type SmokeAuthSession = {
  address: string;
  headers: Record<string, string>;
  ownerCommitment: Hex;
  source: string;
  token: string;
};
type StoredMakerNote = {
  amount: string;
  assetDigest: Hex;
  blinding: Hex;
  blindingSeed?: string;
  commitment: Hex;
  createdAt: number;
  noteNullifier: Hex;
  ownerCommitment: Hex;
  ownerDigest: Hex;
  rho?: string;
  rhoDigest: Hex;
  shieldedPool: string;
  source: string;
  spendSecret?: string;
  spendSecretDigest: Hex;
  status: "available" | "locked" | "spent";
  token: string;
  updatedAt: number;
  walletAddress: string;
  depositTxHash?: Hex | string;
  lockedByIntentCommitment?: Hex;
};

configureSmokeEnvironment();
const env = loadEnv();
const runtime = await createAppRuntimeAsync();
const app = runtime.router;
const clientProver = new ProverService();
const makerSource = argValue("--maker-source") ?? process.env.PNLX_MAKER_SOURCE ?? "pnlx-maker";
const adminSession = await authSessionFor(env.stellarSource);
const makerSession = await authSessionFor(makerSource);
const marketAssets = resolveMarketAssets();
const results = [];

for (const asset of marketAssets) {
  results.push(await runMarketSmoke(asset));
}

console.log(
  JSON.stringify(
    {
      marketCount: results.length,
      assets: results.map((result) => result.symbol),
      results,
    },
    null,
    2,
  ),
);

async function runMarketSmoke(asset: SupportedPerpAsset): Promise<Record<string, unknown>> {
  console.error(`[smoke] ${asset.symbol}: fetching oracle, matching intents, and proving`);
  const startedAt = Date.now();
  const batchId = `batch-${asset.symbol.toLowerCase()}-${Date.now()}`;
  const marketId = asset.marketId;
  const marketPayload = {
    feedId: `0x${feedIdFor(asset)}`,
    marketId,
    maxLeverage: asset.maxLeverage.toString(),
    initialMarginRate: asset.initialMarginRate.toString(),
    maintenanceMarginRate: asset.maintenanceMarginRate.toString(),
    fundingIndex: "0",
  };
  const marketResponse = await postCreateOrRefreshMarket(asset, marketPayload);
  const market = marketResponse.market as Record<string, string>;
  const oracle = marketResponse.oracle as Record<string, string | number>;
  const oraclePrice = BigInt(market.oraclePrice);
  const oraclePublishTime = Number(oracle.publishTime);
  const [longNote, shortNote] = await ensureLiveMakerNotes(asset);
  const margin = minBigInt(BigInt(longNote.amount), BigInt(shortNote.amount));
  const size = tradeSizeForMargin(margin, oraclePrice, asset.maxLeverage);
  const notional = tradeNotional(size, oraclePrice);
  const leverageBps = effectiveLeverageBps(notional, margin);
  const entryPrice = oraclePrice;
  const longLimitPrice = oraclePrice;
  const shortLimitPrice = oraclePrice;
  const alice = noteForProof(longNote);
  const bob = noteForProof(shortNote);

  const aliceIntent = intent(
    asset,
    batchId,
    makerSession.address,
    "long",
    alice.noteNullifier as Hex,
    size,
    margin,
    longLimitPrice,
  );
  const bobIntent = intent(
    asset,
    batchId,
    makerSession.address,
    "short",
    bob.noteNullifier as Hex,
    size,
    margin,
    shortLimitPrice,
  );
  const aliceDeposit = await marginMembership(alice.commitment as Hex);
  const aliceValidity = proveIntentValidity(aliceIntent, alice, aliceDeposit);
  const aliceRecord = await submitPrivateIntent(aliceIntent, aliceValidity);
  lockMakerNote(longNote.commitment, aliceRecord.intentCommitment);

  const bobDeposit = await marginMembership(bob.commitment as Hex);
  const bobValidity = proveIntentValidity(bobIntent, bob, bobDeposit);
  const bobRecord = await submitPrivateIntent(bobIntent, bobValidity);
  lockMakerNote(shortNote.commitment, bobRecord.intentCommitment);
  await registerAccountKey(makerSession.ownerCommitment);
  await waitForExternalMatcherPersistence();

  const settleStartedAt = Date.now();
  let settlementResult: Record<string, unknown>;
  try {
    settlementResult = await settleBatch(batchId, marketId);
  } catch (error) {
    unlockMakerNotes([aliceRecord.intentCommitment, bobRecord.intentCommitment]);
    throw error;
  }
  const settlement = settlementResult.settlement as Record<string, unknown>;
  spendLockedMakerNotes([aliceRecord.intentCommitment, bobRecord.intentCommitment]);
  const settlementMs = Date.now() - settleStartedAt;
  const closeStartedAt = Date.now();
  const close = await closeLongTakeProfit({
    asset,
    aliceRecord,
    batchId,
    ownerAddress: makerSession.address,
    entryPrice,
    fundingIndex: BigInt(market.fundingIndex ?? "0"),
    margin,
    marketId,
    settlement,
    size,
  });
  const closeMs = Date.now() - closeStartedAt;
  const serverSettlementMs = Date.now() - startedAt;
  const context = {
    aliceRecord,
    asset,
    batchId,
    bobRecord,
    close,
    marketId,
    oraclePrice,
    oraclePublishTime,
    settlement,
  };
  const chain = verifyLiveChain(context);

  return {
    symbol: asset.symbol,
    displaySymbol: asset.displaySymbol,
    batchId,
    marketId,
    feedId: `0x${feedIdFor(asset)}`,
    risk: {
      maxLeverage: `${asset.maxLeverage}x`,
      initialMarginRate: rateLabel(asset.initialMarginRate),
      maintenanceMarginRate: rateLabel(asset.maintenanceMarginRate),
    },
    oraclePrice: oraclePrice.toString(),
    oraclePriceUsd: formatUsd(oraclePrice),
    oraclePublishTime,
    size: size.toString(),
    notionalUsd: notional.toString(),
    margin: margin.toString(),
    effectiveLeverage: formatLeverage(leverageBps),
    decision: {
      kind: "open-crossed-perp-then-private-take-profit-close",
      longLimitPrice: formatUsd(longLimitPrice),
      shortLimitPrice: formatUsd(shortLimitPrice),
      fillPrice: formatUsd(entryPrice),
      closePrice: formatUsd(close.markPrice),
      triggerPrice: formatUsd(close.triggerPrice),
      fillReason: "long and short private intents crossed at the same mark-priced limit",
      entryPnl: "0",
      realizedPnl: close.realizedPnl.toString(),
      realizedPnlUsd: formatUsdAmount(close.realizedPnl),
      finalMargin: close.newMargin.toString(),
      finalMarginUsd: formatUsdAmount(close.newMargin),
      pnlStatus: "closed by a proof-verified take-profit trigger and position-close settlement",
    },
    timing: {
      proofAndSubmitMs: settleStartedAt - startedAt,
      settlementMs,
      closeMs,
      serverSettlementMs,
      totalMs: Date.now() - startedAt,
    },
    serverSettlement: settlement,
    chain,
  };
}

function configureSmokeEnvironment(): void {
  const baseEnv = loadEnv();
  const deployment = readDeploymentFile(baseEnv);
  process.env.ASSET_CUSTODY_REQUIRED = "true";
  process.env.AUTH_REQUIRED = "true";
  process.env.SERVER_WITNESS_ROUTES_ENABLED = "false";
  process.env.STELLAR_ONCHAIN_RELAY = "true";
  process.env.STELLAR_RELAYER_MODE = "stellar-cli";
  process.env.ORACLE_CONTRACT_ID ||= deployment.contracts["price-oracle"] ?? "";
}

async function ensureLiveMakerNotes(asset: SupportedPerpAsset): Promise<[StoredMakerNote, StoredMakerNote]> {
  let notes = availableMakerNotes();
  if (notes.length < 2) {
    const largest = notes.sort((left, right) => Number(BigInt(right.amount) - BigInt(left.amount)))[0];
    if (!largest) throw new Error("no available maker notes; run smoke:custody first");
    console.error(`[smoke] ${asset.symbol}: splitting maker note ${largest.commitment}`);
    await splitMakerNote(largest);
    notes = availableMakerNotes();
  }
  if (notes.length < 2) {
    throw new Error("live trade needs two available maker notes after split");
  }
  return [notes[0], notes[1]];
}

async function splitMakerNote(note: StoredMakerNote): Promise<void> {
  if (!note.spendSecret) throw new Error(`maker note ${note.commitment} is missing spendSecret`);
  const noteAmount = BigInt(note.amount);
  const withdrawAmount = noteAmount / 2n;
  const changeAmount = noteAmount - withdrawAmount;
  if (withdrawAmount <= 0n || changeAmount <= 0n) {
    throw new Error(`maker note ${note.commitment} is too small to split`);
  }

  const membership = await marginMembership(note.commitment);
  const changeNote = createCircuitMarginNote({
    amount: changeAmount,
    assetDigest: note.assetDigest,
    assetId: "usdc",
    owner: note.walletAddress,
    spendSecret: note.spendSecret,
    rho: randomLabel("maker-change-rho"),
    blinding: randomLabel("maker-change-blind"),
  });
  const recipientDigest = addressDigestFor(note.walletAddress);
  const withdrawal = clientProver.proveWithdrawal({
    assetDigest: note.assetDigest,
    blinding: note.blinding,
    changeBlinding: changeNote.blinding,
    changeRhoDigest: changeNote.rhoDigest,
    noteAmount,
    noteCommitment: note.commitment,
    nullifier: note.noteNullifier,
    ownerDigest: note.ownerDigest,
    pathIndices: membership.indices,
    pathSiblings: membership.siblings,
    recipient: recipientDigest,
    rhoDigest: note.rhoDigest,
    root: membership.root,
    spendSecretDigest: note.spendSecretDigest,
    tokenDigest: note.assetDigest,
    withdrawAmount,
  });
  await post("/notes/withdraw-asset/proven", {
    ...withdrawal,
    recipientAddress: note.walletAddress,
    recipientDigest,
    token: note.token,
  }, makerSession.headers);

  const deposited = await depositMakerNote({
    amount: withdrawAmount,
    assetDigest: note.assetDigest,
    source: note.source || makerSource,
    token: note.token,
    walletAddress: note.walletAddress,
  });
  saveMakerNotes([
    {
      ...note,
      status: "spent",
      updatedAt: Date.now(),
    },
    storedNoteFromCircuit(changeNote, {
      shieldedPool: note.shieldedPool,
      source: note.source,
      spendSecret: note.spendSecret,
      status: "available",
      token: note.token,
      walletAddress: note.walletAddress,
    }),
    deposited,
    ...readMakerNotes().filter((entry) => entry.commitment !== note.commitment),
  ]);
}

async function depositMakerNote(input: {
  amount: bigint;
  assetDigest?: Hex;
  source: string;
  token: string;
  walletAddress: string;
}): Promise<StoredMakerNote> {
  const spendSecret = randomLabel("maker-deposit-spend");
  const note = createCircuitMarginNote({
    amount: input.amount,
    assetDigest: input.assetDigest ?? (env.collateralTokenDigest as Hex),
    assetId: "usdc",
    owner: input.walletAddress,
    spendSecret,
    rho: randomLabel("maker-deposit-rho"),
    blinding: randomLabel("maker-deposit-blind"),
  });
  const depositProof = clientProver.proveDepositNote({
    amount: input.amount,
    blinding: note.blinding,
    commitment: note.commitment,
    ownerDigest: note.ownerDigest,
    rhoDigest: note.rhoDigest,
    tokenDigest: note.assetDigest,
  });
  await post("/notes/deposit-asset/proven", {
    amount: input.amount,
    commitment: note.commitment,
    depositProof,
    from: input.walletAddress,
    source: input.source,
    token: input.token,
  }, makerSession.headers);
  return storedNoteFromCircuit(note, {
    shieldedPool: readDeployment().contracts["shielded-pool"],
    source: input.source,
    spendSecret,
    status: "available",
    token: input.token,
    walletAddress: input.walletAddress,
  });
}

function storedNoteFromCircuit(
  note: CircuitMarginNote,
  input: {
    shieldedPool: string;
    source: string;
    spendSecret: string;
    status: StoredMakerNote["status"];
    token: string;
    walletAddress: string;
  },
): StoredMakerNote {
  const now = Date.now();
  return {
    amount: note.amount.toString(),
    assetDigest: note.assetDigest as Hex,
    blinding: note.blinding as Hex,
    commitment: note.commitment as Hex,
    createdAt: now,
    noteNullifier: note.noteNullifier as Hex,
    ownerCommitment: ownerCommitment(input.walletAddress),
    ownerDigest: note.ownerDigest as Hex,
    rhoDigest: note.rhoDigest as Hex,
    shieldedPool: input.shieldedPool,
    source: input.source,
    spendSecret: input.spendSecret,
    spendSecretDigest: note.spendSecretDigest as Hex,
    status: input.status,
    token: input.token,
    updatedAt: now,
    walletAddress: input.walletAddress,
  };
}

function noteForProof(note: StoredMakerNote): CircuitMarginNote {
  return {
    amount: BigInt(note.amount),
    assetDigest: note.assetDigest,
    blinding: note.blinding,
    commitment: note.commitment,
    noteNullifier: note.noteNullifier,
    ownerDigest: note.ownerDigest,
    rhoDigest: note.rhoDigest,
    spendSecretDigest: note.spendSecretDigest,
  };
}

async function marginMembership(commitment: Hex): Promise<MarginMembershipProof> {
  const response = await get(`/notes/membership?commitment=${encodeURIComponent(commitment)}`, makerSession.headers);
  const note = response.note as { membershipProof: MarginMembershipProof };
  return note.membershipProof;
}

function availableMakerNotes(): StoredMakerNote[] {
  return readMakerNotes()
    .filter((note) => note.status === "available")
    .filter((note) => note.walletAddress === makerSession.address)
    .sort((left, right) => Number(BigInt(left.amount) - BigInt(right.amount)));
}

function lockMakerNote(commitment: Hex, intentCommitment: Hex): void {
  saveMakerNotes(
    readMakerNotes().map((note) =>
      note.commitment === commitment
        ? { ...note, lockedByIntentCommitment: intentCommitment, status: "locked", updatedAt: Date.now() }
        : note,
    ),
  );
}

function spendLockedMakerNotes(intentCommitments: Hex[]): void {
  const intents = new Set(intentCommitments);
  saveMakerNotes(
    readMakerNotes().map((note) =>
      note.lockedByIntentCommitment && intents.has(note.lockedByIntentCommitment)
        ? { ...note, status: "spent", updatedAt: Date.now() }
        : note,
    ),
  );
}

function unlockMakerNotes(intentCommitments: Hex[]): void {
  const intents = new Set(intentCommitments);
  saveMakerNotes(
    readMakerNotes().map((note) =>
      note.lockedByIntentCommitment && intents.has(note.lockedByIntentCommitment)
        ? {
            ...note,
            lockedByIntentCommitment: undefined,
            status: "available",
            updatedAt: Date.now(),
          }
        : note,
    ),
  );
}

function readMakerNotes(): StoredMakerNote[] {
  const path = makerNotesPath();
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as StoredMakerNote[]).filter((note) => note.commitment);
}

function saveMakerNotes(notes: StoredMakerNote[]): void {
  const path = makerNotesPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const byCommitment = new Map<string, StoredMakerNote>();
  for (const note of notes) byCommitment.set(note.commitment, note);
  writeFileSync(path, `${JSON.stringify([...byCommitment.values()], null, 2)}\n`, { mode: 0o600 });
}

function makerNotesPath(): string {
  return join(process.env.PNLX_RUNTIME_DIR || ".pnlx", "maker-notes.json");
}

function proveIntentValidity(
  tradeIntent: TradeIntent,
  note: CircuitMarginNote,
  membershipProof: MarginMembershipProof,
): IntentValidityRecord {
  return clientProver.proveIntentValidity({
    intent: tradeIntent,
    currentBatch: 1n,
    expiryBatch: 2n,
    assetDigest: note.assetDigest,
    blinding: note.blinding,
    changeBlinding: "0x0",
    changeRhoDigest: "0x0",
    marginRoot: membershipProof.root,
    noteAmount: note.amount,
    noteChangeCommitment: "0x0",
    noteCommitment: note.commitment,
    ownerDigest: note.ownerDigest,
    pathIndices: membershipProof.indices,
    pathSiblings: membershipProof.siblings,
    rhoDigest: note.rhoDigest,
    spendSecretDigest: note.spendSecretDigest,
  });
}

async function submitPrivateIntent(
  tradeIntent: TradeIntent,
  validity: IntentValidityRecord,
): Promise<IntentRecord> {
  return await post("/intents", {
    intent: {
      ...tradeIntent,
      limitPrice: tradeIntent.limitPrice.toString(),
      margin: tradeIntent.margin.toString(),
      size: tradeIntent.size.toString(),
    },
    validity: {
      ...validity,
      currentBatch: validity.currentBatch.toString(),
      expiryBatch: validity.expiryBatch.toString(),
    },
  }, makerSession.headers) as unknown as IntentRecord;
}

async function registerAccountKey(owner: Hex): Promise<void> {
  await post("/account-keys", {
    algorithm: "ecdh-p256-aes-gcm",
    ownerCommitment: owner,
    publicKey: rawP256PublicKey(),
  }, makerSession.headers);
}

async function waitForExternalMatcherPersistence(): Promise<void> {
  if (!env.matcherServiceUrl || env.protocolStorageDriver !== "mongodb") return;
  await new Promise((resolve) => setTimeout(resolve, 750));
}

async function settleBatch(batchId: string, marketId: string): Promise<Record<string, unknown>> {
  if (!env.matcherServiceUrl) {
    return post("/batches/settle", { batchId, marketId }, adminSession.headers);
  }
  const transcript = await requestMatcherSettlement(batchId, marketId);
  return post("/batches/settle-external", transcript, adminSession.headers);
}

async function requestMatcherSettlement(batchId: string, marketId: string): Promise<Record<string, unknown>> {
  const timeoutMs = smokeMatcherTimeoutMs();
  const startedAt = Date.now();
  let response: { status: number; text: string };
  try {
    response = await postJsonUrl(new URL("/match/settlement", env.matcherServiceUrl), {
      batchId,
      marketId,
    }, {
      ...(env.matcherServiceToken ? { authorization: `Bearer ${env.matcherServiceToken}` } : {}),
    }, timeoutMs);
  } catch (error) {
    throw new Error(
      `/match/settlement failed after ${Date.now() - startedAt}ms; set PNLX_SMOKE_MATCHER_TIMEOUT_MS to wait longer\n${String(
        error,
      )}`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`/match/settlement failed: ${response.status} ${response.text}`);
  }
  return JSON.parse(response.text) as Record<string, unknown>;
}

function postJsonUrl(
  url: URL,
  data: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(serialize(data));
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    try {
      const request = transport({
        hostname: url.hostname,
        method: "POST",
        path: `${url.pathname}${url.search}`,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        protocol: url.protocol,
        headers: {
          "content-length": Buffer.byteLength(body).toString(),
          "content-type": "application/json",
          ...headers,
        },
        timeout: timeoutMs,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      request.on("error", reject);
      request.on("timeout", () => {
        request.destroy(new Error(`matcher request timed out after ${timeoutMs}ms`));
      });
      request.write(body);
      request.end();
    } catch (error) {
      reject(error);
    }
  });
}

function smokeMatcherTimeoutMs(): number {
  const raw = process.env.PNLX_SMOKE_MATCHER_TIMEOUT_MS;
  if (!raw) return 30 * 60 * 1000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`PNLX_SMOKE_MATCHER_TIMEOUT_MS must be a positive integer, got ${raw}`);
  }
  return parsed;
}

async function closeLongTakeProfit(input: {
  aliceRecord: IntentRecord;
  asset: SupportedPerpAsset;
  batchId: string;
  entryPrice: bigint;
  fundingIndex: bigint;
  margin: bigint;
  marketId: string;
  ownerAddress: string;
  settlement: Record<string, unknown>;
  size: bigint;
}): Promise<{
  closeCommitment: Hex;
  conditionalClose: ConditionalOrderRecord;
  markPrice: bigint;
  newMargin: bigint;
  newPositionCommitment: Hex;
  positionClose: PositionCloseRecord;
  positionNullifier: Hex;
  realizedPnl: bigint;
  triggerPrice: bigint;
}> {
  const markPrice = (input.entryPrice * 106n) / 100n;
  const triggerPrice = (input.entryPrice * 105n) / 100n;
  const positionCommitments = parseHexList(input.settlement.newCommitments, "settlement.newCommitments");
  const position = settledLongPosition(input, positionCommitments);
  const positionNullifier = position.position.positionNullifier as Hex;
  const witness: ConditionalOrderWitness = {
    marketId: input.marketId,
    positionNullifier,
    side: "long",
    kind: "take-profit",
    triggerPrice,
    markPrice,
    size: input.size,
    reduceOnly: true,
    salt: `${input.asset.symbol.toLowerCase()}-alice-tp-${input.batchId}`,
  };
  const closeCommitment = commitConditionalOrder(witness);
  publishOraclePriceOnChain({
    asset: input.asset,
    oraclePrice: markPrice,
    oraclePublishTime: Math.floor(Date.now() / 1000),
  });
  await post("/markets/update", {
    marketId: input.marketId,
    oraclePrice: markPrice,
    maxLeverage: input.asset.maxLeverage,
    initialMarginRate: input.asset.initialMarginRate,
    maintenanceMarginRate: input.asset.maintenanceMarginRate,
    fundingIndex: input.fundingIndex,
  }, adminSession.headers);
  await post("/conditional-orders", {
    marketId: input.marketId,
    positionNullifier,
    closeCommitment,
  }, makerSession.headers);
  const triggerRecord = clientProver.proveConditionalClose(witness);
  const triggerResponse = await post("/conditional-orders/trigger-proven", triggerRecord, makerSession.headers);
  const conditionalClose = triggerResponse.conditionalClose as ConditionalOrderRecord;

  const closeSettlement = settleClose({
    side: "long",
    closeSize: input.size,
    entryPrice: input.entryPrice,
    markPrice,
    margin: input.margin,
    fundingPayment: 0n,
    fee: 0n,
  });
  const marginOutput = createCircuitMarginNote({
    assetId: "usdc",
    amount: closeSettlement.newMargin,
    owner: input.aliceRecord.ownerCommitment,
    spendSecret: `${positionNullifier}:close-margin-spend`,
    rho: `${positionNullifier}:close-margin-rho`,
    blinding: `${positionNullifier}:close-margin-blinding`,
  });
  const closeContext = await positionCloseContext({
    newPositionCommitment: position.newPositionCommitment,
    ownerCommitment: input.aliceRecord.ownerCommitment,
    positionCommitment: position.position.commitment as Hex,
  });
  const provenClose = clientProver.provePositionClose({
    marketId: input.marketId,
    positionCommitment: position.position.commitment,
    positionRoot: closeContext.positionRoot,
    positionNullifier,
    closeCommitment,
    side: "long",
    size: input.size,
    closeSize: input.size,
    entryPrice: input.entryPrice,
    markPrice,
    margin: input.margin,
    fundingPayment: 0n,
    fee: 0n,
    newMargin: closeSettlement.newMargin,
    fundingIndex: input.fundingIndex,
    remainingMargin: 0n,
    marginOutputAmount: closeSettlement.newMargin,
    newPositionCommitment: position.newPositionCommitment,
    newPositionRoot: closeContext.newPositionRoot,
    marginOutputCommitment: marginOutput.commitment,
    marketDigest: position.position.marketDigest,
    ownerDigest: position.position.ownerDigest,
    rhoDigest: position.position.rhoDigest,
    blinding: position.position.blinding,
    spendSecretDigest: position.position.spendSecretDigest,
    newPositionRhoDigest: position.newPosition.rhoDigest,
    newPositionBlinding: position.newPosition.blinding,
    marginOutputAssetDigest: marginOutput.assetDigest,
    marginOutputRhoDigest: marginOutput.rhoDigest,
    marginOutputBlinding: marginOutput.blinding,
    pathIndices: closeContext.membershipProof.indices,
    pathSiblings: closeContext.membershipProof.siblings,
  });
  const closeResponse = await post("/position-closes/proven", provenClose, makerSession.headers);
  const positionClose = closeResponse.positionClose as PositionCloseRecord;

  return {
    closeCommitment,
    conditionalClose,
    markPrice,
    newMargin: closeSettlement.newMargin,
    newPositionCommitment: position.newPositionCommitment,
    positionClose,
    positionNullifier,
    realizedPnl: closeSettlement.realizedPnl,
    triggerPrice,
  };
}

async function positionCloseContext(input: {
  newPositionCommitment: Hex;
  ownerCommitment: Hex;
  positionCommitment: Hex;
}): Promise<{
  membershipProof: MarginMembershipProof;
  newPositionRoot: Hex;
  positionRoot: Hex;
}> {
  const params = new URLSearchParams({
    newPositionCommitment: input.newPositionCommitment,
    ownerCommitment: input.ownerCommitment,
    positionCommitment: input.positionCommitment,
  });
  const response = await get(`/position-closes/context?${params.toString()}`, makerSession.headers);
  const context = response.context as Record<string, unknown>;
  const proof = context.membershipProof as Record<string, unknown>;
  return {
    membershipProof: {
      indices: parseBooleanList(proof.indices, "positionCloseContext.membershipProof.indices"),
      root: String(proof.root) as Hex,
      siblings: parseHexList(proof.siblings, "positionCloseContext.membershipProof.siblings"),
    },
    newPositionRoot: String(context.newPositionRoot) as Hex,
    positionRoot: String(context.positionRoot) as Hex,
  };
}

function settledLongPosition(
  input: {
    aliceRecord: IntentRecord;
    asset: SupportedPerpAsset;
    entryPrice: bigint;
    fundingIndex: bigint;
    margin: bigint;
    marketId: string;
    ownerAddress: string;
    size: bigint;
  },
  positionCommitments: Hex[],
): {
  newPositionCommitment: Hex;
  newPosition: ReturnType<typeof createCircuitPositionNote>;
  position: ReturnType<typeof createCircuitPositionNote>;
} {
  if (positionCommitments.length === 0) {
    throw new Error("settlement did not create positions");
  }

  const fillIndex = 0;
  const owner = input.aliceRecord.ownerCommitment;
  const rho = `${input.aliceRecord.intentCommitment}:position:${fillIndex}`;
  const position = createCircuitPositionNote({
    marketId: input.marketId,
    side: "long",
    size: input.size,
    entryPrice: input.entryPrice,
    margin: input.margin,
    fundingIndex: input.fundingIndex,
    owner,
    spendSecret: `${owner}:${rho}`,
    rho,
    blinding: `${input.aliceRecord.intentCommitment}:blinding:${fillIndex}`,
  });
  if (position.commitment !== positionCommitments[fillIndex]) {
    throw new Error("reconstructed position does not match settled commitment");
  }

  const newPosition = createCircuitPositionNote({
    marketId: input.marketId,
    side: "long",
    size: 0n,
    entryPrice: input.entryPrice,
    margin: 0n,
    fundingIndex: input.fundingIndex,
    owner,
    spendSecret: `${owner}:${position.positionNullifier}:closed-position-spend`,
    rho: `${position.positionNullifier}:closed-position-rho`,
    blinding: `${position.positionNullifier}:closed-position-blinding`,
  });
  const newPositionCommitment = newPosition.commitment as Hex;
  return {
    newPositionCommitment,
    newPosition,
    position,
  };
}

function parseHexList(value: unknown, field: string): Hex[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry) => String(entry) as Hex);
}

function parseBooleanList(value: unknown, field: string): boolean[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry) => entry === true || entry === "true");
}

function rawP256PublicKey(): string {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
}

function intent(
  asset: SupportedPerpAsset,
  batchId: string,
  owner: string,
  side: "long" | "short",
  noteNullifier: Hex,
  size: bigint,
  margin: bigint,
  limitPrice: bigint,
): TradeIntent {
  return {
    batchId,
    marketId: asset.marketId,
    owner,
    side,
    size,
    limitPrice,
    margin,
    noteNullifier,
    nonce: `${side}-${batchId}-${noteNullifier}`,
    salt: `${side}-salt-${batchId}-${noteNullifier}`,
  };
}

async function get(
  path: string,
  headers: Record<string, string> = adminSession.headers,
): Promise<Record<string, unknown>> {
  const response = await app.handle(
    new Request(`http://pnlx.local${path}`, {
      headers,
    }),
  );
  const text = await response.text();
  await flushProtocolStore();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function post(
  path: string,
  data: unknown,
  headers: Record<string, string> = adminSession.headers,
): Promise<Record<string, unknown>> {
  const response = await app.handle(
    new Request(`http://pnlx.local${path}`, {
      method: "POST",
      body: JSON.stringify(serialize(data)),
      headers,
    }),
  );
  const text = await response.text();
  await flushProtocolStore();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function flushProtocolStore(): Promise<void> {
  const flush = (runtime.executor.store as { flush?: () => Promise<void> }).flush;
  if (flush) await flush.call(runtime.executor.store);
}

async function postPublic(path: string, data: unknown): Promise<Record<string, unknown>> {
  return post(path, data, { "content-type": "application/json" });
}

async function authSessionFor(source: string): Promise<SmokeAuthSession> {
  if (/^G[A-Z0-9]{55}$/.test(source)) {
    throw new Error(`auth source must be a local Stellar key alias, got public address ${source}`);
  }
  const address = resolveSourceAddress(source);
  const secret = runStellar(["keys", "secret", source]).trim();
  const challenge = await postPublic("/auth/challenge", {
    address,
    domain: "pnlx.local",
    uri: "http://pnlx.local",
  });
  const message = String(challenge.message);
  const signature = sign(null, stellarSignedMessageHash(message), privateKeyFromStellarSecret(secret)).toString("base64");
  const session = await postPublic("/auth/session", {
    address,
    nonce: challenge.nonce,
    signature,
  });
  const token = String(session.token);
  return {
    address,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ownerCommitment: String(session.ownerCommitment) as Hex,
    source,
    token,
  };
}

async function postCreateOrRefreshMarket(
  asset: SupportedPerpAsset,
  data: Record<string, string>,
): Promise<Record<string, unknown>> {
  const oracle = await latestHermesPrice(data.feedId as Hex);
  publishOraclePriceOnChain({
    asset,
    oraclePrice: BigInt(oracle.price),
    oraclePublishTime: Number(oracle.publishTime),
  });
  const market = {
    fundingIndex: data.fundingIndex,
    initialMarginRate: data.initialMarginRate,
    maintenanceMarginRate: data.maintenanceMarginRate,
    marketId: data.marketId,
    maxLeverage: data.maxLeverage,
    oraclePrice: oracle.price.toString(),
  };
  try {
    const created = await post("/markets", market);
    return {
      market: created.market,
      oracle,
    };
  } catch (error) {
    if (!String((error as Error).message).includes("market already exists")) throw error;
    const refreshed = await post("/markets/update", market);
    return {
      market: refreshed.market,
      oracle,
    };
  }
}

async function latestHermesPrice(feedId: Hex): Promise<Record<string, bigint | number | string>> {
  const url = new URL("/v2/updates/price/latest", env.pythHermesUrl);
  url.searchParams.append("ids[]", feedId.slice(2));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`pyth price fetch failed: ${response.status}`);
  const body = await response.json() as {
    parsed?: Array<{
      id: string;
      price: {
        conf: string;
        expo: number;
        price: string;
        publish_time: number;
      };
    }>;
  };
  const parsed = body.parsed?.find((entry) => entry.id === feedId.slice(2));
  if (!parsed) throw new Error("pyth feed missing from response");
  const price = scalePythPrice(BigInt(parsed.price.price), parsed.price.expo);
  const confidence = scalePythPrice(BigInt(parsed.price.conf), parsed.price.expo);
  if (price <= 0n) throw new Error("pyth price must be positive");
  return {
    confidence,
    confidenceBps: (confidence * 10_000n) / (price < 0n ? -price : price),
    feedId,
    price,
    publishTime: parsed.price.publish_time,
    source: "hermes",
  };
}

function publishOraclePriceOnChain(context: OraclePublishContext): void {
  console.error(`[smoke] ${context.asset.symbol}: publishing oracle price on-chain`);
  const deployment = readDeployment();
  const oracleContract = activeOracleContract(deployment);
  pushAdapterPrice(deployment, oracleContract, context);
}

function verifyLiveChain(context: MarketSmokeContext): Record<string, unknown> {
  console.error(`[smoke] ${context.asset.symbol}: verifying live Stellar settlement`);
  const startedAt = Date.now();
  const deployment = readDeployment();
  const proof = context.settlement.proof as unknown as ProofMeta;
  const batchKey = bytes32(hashFields("batch-id", [context.batchId]));
  const marketKey = bytes32(hashFields("market-id", [context.marketId]));

  if (proof.proofSystem !== "risc0-groth16") {
    throw new Error("batch settlement must use a RISC0 Groth16 matcher proof");
  }
  const risc0Verifier = deployment.verifiers["batch-match-risc0-verifier"];
  if (!risc0Verifier) {
    throw new Error("deployment is missing batch-match-risc0-verifier");
  }

  waitForProof(deployment, proof);
  waitForSettlement(deployment, batchKey, marketKey);
  waitForProof(deployment, context.close.conditionalClose.proof);
  waitForProof(deployment, context.close.positionClose.proof);
  waitForPositionClose(deployment, context.close.closeCommitment);

  return {
    deployment: env.stellarDeploymentFile,
    batchSettlement: deployment.contracts["batch-settlement"],
    batchProofVerifier: risc0Verifier,
    conditionalOrder: deployment.contracts["conditional-order"],
    positionClose: deployment.contracts["position-close"],
    oracleContract: activeOracleContract(deployment),
    oracleKind: env.oracleKind,
    oracleAsset:
      context.asset.oracleAssetType === "stellar"
        ? context.asset.oracleAssetAddress
        : context.asset.oracleAssetSymbol,
    closeSettled: "true",
    isSettled: "true",
    verificationMs: Date.now() - startedAt,
  };
}

function activeOracleContract(deployment: Deployment): string {
  return env.oracleContractId || deployment.contracts["price-oracle"];
}

function pushAdapterPrice(
  deployment: Deployment,
  oracleContract: string,
  context: OraclePublishContext,
): void {
  if (oracleContract !== deployment.contracts["price-oracle"]) return;

  const oracleAsset =
    context.asset.oracleAssetType === "stellar"
      ? context.asset.oracleAssetAddress
      : context.asset.oracleAssetSymbol;
  if (!oracleAsset) {
    throw new Error(`missing oracle asset for ${context.asset.symbol}`);
  }
  const timestamp = Math.max(1, context.oraclePublishTime - 5);
  const method =
    context.asset.oracleAssetType === "stellar" ? "submit_stellar_price" : "submit_other_price";

  if (env.oraclePublishMode === "committee") {
    const round = String(Date.now());
    for (const publisher of publisherSources(deployment)) {
      invokeFromSource(publisher.source, oracleContract, method, [
        "--publisher",
        publisher.address,
        "--asset",
        oracleAsset,
        "--round",
        round,
        "--price",
        context.oraclePrice.toString(),
        "--timestamp",
        String(timestamp),
      ]);
    }
    return;
  }

  invoke(
    oracleContract,
    context.asset.oracleAssetType === "stellar" ? "set_stellar_price" : "set_other_price",
    [
      "--admin",
      deployment.sourceAddress,
      "--asset",
      oracleAsset,
      "--price",
      context.oraclePrice.toString(),
      "--timestamp",
      String(timestamp),
    ],
  );
}

function waitForProof(deployment: Deployment, proof: ProofMeta): void {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    console.error(`[stellar] has_proof attempt ${attempt}`);
    const hasProof = invoke(deployment.contracts["proof-ledger"], "has_proof", [
      "--circuit_id",
      bytes32(proof.circuitKey),
      "--verifier_hash",
      bytes32(proof.verifierHash),
      "--public_input_hash",
      bytes32(proof.publicInputHash),
      "--proof_digest",
      bytes32(proof.proofDigest),
    ]);
    if (hasProof.trim() === "true") return;
    sleep(2500);
  }

  throw new Error(`proof was not recorded for ${proof.publicInputHash}`);
}

function waitForSettlement(deployment: Deployment, batchKey: string, marketKey: string): void {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    console.error(`[stellar] is_settled attempt ${attempt}`);
    const settled = invoke(deployment.contracts["batch-settlement"], "is_settled", [
      "--batch_id",
      batchKey,
      "--market_id",
      marketKey,
    ]);
    if (settled.trim() === "true") return;
    sleep(2500);
  }

  throw new Error(`batch was not settled for ${batchKey}:${marketKey}`);
}

function waitForPositionClose(deployment: Deployment, closeCommitment: Hex): void {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    console.error(`[stellar] close is_settled attempt ${attempt}`);
    const settled = invoke(deployment.contracts["position-close"], "is_settled", [
      "--close_commitment",
      bytes32(closeCommitment),
    ]);
    if (settled.trim() === "true") return;
    sleep(2500);
  }

  throw new Error(`position close was not settled for ${closeCommitment}`);
}

function addressDigestFor(address: string): Hex {
  const deployment = readDeployment();
  const output = invoke(deployment.contracts["shielded-pool"], "token_digest", ["--token", address]);
  return parseHex32(output, `address digest for ${address}`);
}

function publisherSources(deployment: Deployment): { address: string; source: string }[] {
  const sources =
    env.oraclePublisherSources.length > 0 ? env.oraclePublisherSources : [env.stellarSource];
  return sources.map((source) => ({
    source,
    address: source === env.stellarSource ? deployment.sourceAddress : resolveSourceAddress(source),
  }));
}

function resolveSourceAddress(source: string): string {
  if (/^G[A-Z0-9]{55}$/.test(source)) return source;
  const output = runStellar(["keys", "address", source]);
  const address = output.match(/\bG[A-Z0-9]{55}\b/)?.[0];
  if (!address) throw new Error(`could not parse publisher address for ${source}`);
  return address;
}

function runStellar(command: string[]): string {
  const result = spawnSync("stellar", command, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0) {
    throw new Error(`stellar ${command.join(" ")} failed\n${output}`);
  }
  return output;
}

function readDeployment(): Deployment {
  return readDeploymentFile(env);
}

function readDeploymentFile(input: Pick<ReturnType<typeof loadEnv>, "stellarDeployerAddress" | "stellarDeploymentFile">): Deployment {
  const path = join(process.cwd(), input.stellarDeploymentFile);
  if (!existsSync(path)) {
    throw new Error(
      `missing deployment file ${path}; fund ${input.stellarDeployerAddress} and run deploy first`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

function invoke(contractId: string, method: string, args: string[]): string {
  return invokeFromSource(env.stellarSource, contractId, method, args);
}

function invokeFromSource(source: string, contractId: string, method: string, args: string[]): string {
  const send = new Set(["current_root", "has_proof", "is_settled", "token_digest"]).has(method)
    ? "no"
    : "yes";
  const command = [
    "stellar",
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    source,
    "--network",
    env.stellarNetwork,
    ...networkArgs(),
    "--network-passphrase",
    env.stellarNetworkPassphrase,
    "--send",
    send,
    "--auto-sign",
    "--",
    method,
    ...args,
  ];

  let last = "";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    console.error(`[stellar] ${method} ${contractId.slice(0, 8)} attempt ${attempt}`);
    const result = spawnSync(command[0], command.slice(1), {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90_000,
    });
    last = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.error) {
      last = [last, result.error.message].filter(Boolean).join("\n");
    }
    if (result.status === 0) {
      if (send === "yes") sleep(3500);
      return last;
    }
    sleep(6000);
  }

  throw new Error(`${method} failed\n${last}`);
}

function networkArgs(): string[] {
  return [
    ...(env.stellarRpcUrl ? ["--rpc-url", env.stellarRpcUrl] : []),
  ];
}

function resolveMarketAssets(): SupportedPerpAsset[] {
  const arg = process.argv.find((entry) => entry.startsWith("--markets="));
  const symbols = arg
    ? arg.slice("--markets=".length).split(",")
    : env.smokeMarketSymbols;
  const seen = new Set<string>();
  const assets = symbols
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .filter((symbol) => {
      if (seen.has(symbol)) return false;
      seen.add(symbol);
      return true;
    })
    .map(getSupportedPerpAsset);

  if (assets.length === 0) throw new Error("no smoke markets selected");
  return assets;
}

function feedIdFor(asset: SupportedPerpAsset): string {
  return env.pythFeedIds[asset.symbol] ?? asset.pythFeedId;
}

function tradeSizeForMargin(margin: bigint, price: bigint, leverage: bigint): bigint {
  const safeLeverage = leverage > 2n ? leverage / 2n : 1n;
  const notional = margin * safeLeverage;
  const size = (notional * PRICE_SCALE) / price;
  return size > 0n ? size : 1n;
}

function tradeNotional(size: bigint, price: bigint): bigint {
  return (size * price) / PRICE_SCALE;
}

function scalePythPrice(value: bigint, expo: number): bigint {
  if (expo >= 0) return value * 10n ** BigInt(expo) * PRICE_SCALE;
  return (value * PRICE_SCALE) / 10n ** BigInt(-expo);
}

function effectiveLeverageBps(notional: bigint, margin: bigint): bigint {
  if (margin === 0n) return 0n;
  return (notional * 10_000n) / margin;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serialize(entry)]),
  );
}

function bytes32(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function parseHex32(output: string, label: string): Hex {
  const value = output.match(/(?:0x)?[0-9a-fA-F]{64}/)?.[0];
  if (!value) throw new Error(`could not parse ${label}\n${output}`);
  return value.startsWith("0x") ? (value.toLowerCase() as Hex) : (`0x${value.toLowerCase()}` as Hex);
}

function formatUsd(price: bigint): string {
  const whole = price / PRICE_SCALE;
  const frac = ((price % PRICE_SCALE) / 1_000_000n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

function formatUsdAmount(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute}.00`;
}

function formatLeverage(leverageBps: bigint): string {
  const whole = leverageBps / 10_000n;
  const frac = ((leverageBps % 10_000n) / 100n).toString().padStart(2, "0");
  return `${whole}.${frac}x`;
}

function rateLabel(rate: bigint): string {
  const bps = rate / 100n;
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = process.argv.find((entry) => entry.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function randomLabel(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function privateKeyFromStellarSecret(secret: string) {
  const decoded = base32Decode(secret.trim());
  if (decoded.length !== 35) throw new Error("invalid stellar secret length");
  const payload = decoded.subarray(0, 33);
  const checksum = decoded.subarray(33);
  const expected = crc16Xmodem(payload);
  if (checksum[0] !== (expected & 0xff) || checksum[1] !== (expected >> 8)) {
    throw new Error("invalid stellar secret checksum");
  }
  if (payload[0] !== ED25519_SECRET_KEY_VERSION) {
    throw new Error("invalid stellar secret version");
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, payload.subarray(1)]),
    format: "der",
    type: "pkcs8",
  });
}

function base32Decode(value: string): Buffer {
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (const char of value.replace(/=+$/g, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid stellar secret character");
    bits = (bits << 5) | index;
    bitCount += 5;
    while (bitCount >= 8) {
      bytes.push((bits >> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }

  return Buffer.from(bytes);
}

function crc16Xmodem(value: Buffer): number {
  let crc = 0;
  for (const byte of value) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
