import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  commitConditionalOrder,
  fieldMerkleProof,
  fieldMerkleRoot,
  hashFields,
  ownerCommitment,
} from "@merkl/crypto";
import { PRICE_SCALE, settleClose } from "@merkl/market-math";
import { createCircuitMarginNote, createCircuitPositionNote } from "@merkl/sdk";
import type {
  ConditionalOrderRecord,
  ConditionalOrderWitness,
  Hex,
  IntentRecord,
  IntentValidityRecord,
  PositionCloseRecord,
  TradeIntent,
} from "@merkl/protocol-types";
import { createApp } from "@/app";
import { getSupportedPerpAsset, type SupportedPerpAsset } from "@/config/assets";
import { loadEnv } from "@/config/env";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { ThresholdShareCommittee } from "@/workers/threshold-shares/threshold-shares.service";
import { ProverService } from "@/workers/prover/prover.service";

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
type PositionMembershipProof = MarginMembershipProof;

const serverOnly = process.argv.includes("--server-only");
configureSmokeEnvironment();
const env = loadEnv();
const app = createApp();
const clientProver = new ProverService();
const clientCommittee = new ThresholdShareCommittee({
  nodeIds: ["node-a", "node-b", "node-c"],
  threshold: 2,
});
const marketAssets = resolveMarketAssets();
const knownPositionCommitments: Hex[] = loadKnownPositionCommitments(env.protocolStorePath);
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
  const alice = createCircuitMarginNote({
    assetId: "usdc",
    amount: 40_000n,
    owner: `${asset.symbol.toLowerCase()}-alice`,
    spendSecret: `alice-${batchId}`,
    rho: `alice-rho-${batchId}`,
    blinding: `alice-blind-${batchId}`,
  });
  const bob = createCircuitMarginNote({
    assetId: "usdc",
    amount: 40_000n,
    owner: `${asset.symbol.toLowerCase()}-bob`,
    spendSecret: `bob-${batchId}`,
    rho: `bob-rho-${batchId}`,
    blinding: `bob-blind-${batchId}`,
  });

  const marketPayload = {
    feedId: `0x${feedIdFor(asset)}`,
    marketId,
    maxLeverage: asset.maxLeverage.toString(),
    initialMarginRate: asset.initialMarginRate.toString(),
    maintenanceMarginRate: asset.maintenanceMarginRate.toString(),
    fundingIndex: "0",
  };
  const marketResponse = await postCreateOrRefreshMarket(marketPayload);
  const market = marketResponse.market as Record<string, string>;
  const oracle = marketResponse.oracle as Record<string, string | number>;
  const oraclePrice = BigInt(market.oraclePrice);
  const oraclePublishTime = Number(oracle.publishTime);
  const size = tradeSize(oraclePrice);
  const margin = tradeMargin(size, oraclePrice, asset.maxLeverage);
  const notional = tradeNotional(size, oraclePrice);
  const leverageBps = effectiveLeverageBps(notional, margin);
  const entryPrice = oraclePrice;
  const longLimitPrice = oraclePrice;
  const shortLimitPrice = oraclePrice;

  const aliceIntent = intent(
    asset,
    batchId,
    "alice",
    "long",
    alice.noteNullifier as Hex,
    size,
    margin,
    longLimitPrice,
  );
  const bobIntent = intent(
    asset,
    batchId,
    "bob",
    "short",
    bob.noteNullifier as Hex,
    size,
    margin,
    shortLimitPrice,
  );
  const aliceDeposit = await depositCircuitNote(alice);
  const aliceValidity = proveIntentValidity(aliceIntent, alice, aliceDeposit);
  const aliceRecord = await submitSharedIntent(aliceIntent, aliceValidity);

  const bobDeposit = await depositCircuitNote(bob);
  const bobValidity = proveIntentValidity(bobIntent, bob, bobDeposit);
  const bobRecord = await submitSharedIntent(bobIntent, bobValidity);

  const settleStartedAt = Date.now();
  const settlementResult = await post("/batches/settle", { batchId, marketId });
  const settlement = settlementResult.settlement as Record<string, unknown>;
  const settlementMs = Date.now() - settleStartedAt;
  const closeStartedAt = Date.now();
  const close = await closeLongTakeProfit({
    asset,
    aliceRecord,
    batchId,
    entryPrice,
    fundingIndex: BigInt(market.fundingIndex ?? "0"),
    margin,
    marketId,
    priorPositionCommitments: [...knownPositionCommitments],
    settlement,
    size,
  });
  knownPositionCommitments.push(
    ...parseHexList(settlement.newCommitments, "settlement.newCommitments"),
    close.newPositionCommitment,
  );
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
  const chain = serverOnly ? undefined : pushOnChain(context);

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
  const runtimeDir = serverOnly
    ? mkdtempSync(join(tmpdir(), "merkl-smoke-"))
    : smokeRuntimeDir(baseEnv);
  process.env.ASSET_CUSTODY_REQUIRED = "false";
  process.env.AUTH_REQUIRED = "false";
  process.env.FUNDING_ENGINE_ENABLED = process.env.FUNDING_ENGINE_ENABLED || "false";
  process.env.SERVER_WITNESS_ROUTES_ENABLED = "true";
  process.env.STELLAR_ONCHAIN_RELAY = "false";
  process.env.STELLAR_RELAYER_MODE = "local";
  process.env.PROTOCOL_STORE_PATH ??= join(runtimeDir, "protocol-store.json");
  process.env.RELAY_STORE_PATH ??= join(runtimeDir, "relay-store.json");
  process.env.AUTH_STORE_PATH ??= join(runtimeDir, "auth-store.json");
}

function smokeRuntimeDir(baseEnv: ReturnType<typeof loadEnv>): string {
  if (process.env.MERKL_SMOKE_RUNTIME_DIR) return process.env.MERKL_SMOKE_RUNTIME_DIR;

  const deployment = readDeploymentFile(baseEnv);
  const key = hashFields("smoke-runtime", [
    baseEnv.stellarNetwork,
    baseEnv.stellarDeploymentFile,
    deployment.contracts["position-state"],
    deployment.contracts["batch-settlement"],
  ]).slice(2, 14);
  return join(".merkl", "smoke", `${baseEnv.stellarNetwork}-${key}`);
}

async function depositCircuitNote(note: CircuitMarginNote): Promise<MarginMembershipProof> {
  const deposit = await post("/notes/deposit", { commitment: note.commitment });
  const result = deposit.note as { membershipProof: MarginMembershipProof };
  return result.membershipProof;
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
    marginRoot: membershipProof.root,
    noteAmount: note.amount,
    noteCommitment: note.commitment,
    ownerDigest: note.ownerDigest,
    pathIndices: membershipProof.indices,
    pathSiblings: membershipProof.siblings,
    rhoDigest: note.rhoDigest,
    spendSecretDigest: note.spendSecretDigest,
  });
}

async function submitSharedIntent(
  tradeIntent: TradeIntent,
  validity: IntentValidityRecord,
): Promise<IntentRecord> {
  const shareSets = clientCommittee.shareIntent(tradeIntent, validity.intentCommitment);
  const shareCommitment = clientCommittee.shareCommitment(
    "intent-shares",
    validity.intentCommitment,
    shareSets,
  );
  return await post("/intents/shared", {
    record: {
      batchDigest: validity.batchDigest,
      batchId: tradeIntent.batchId,
      intentCommitment: validity.intentCommitment,
      marketDigest: validity.marketDigest,
      marketId: tradeIntent.marketId,
      marginRoot: validity.marginRoot,
      noteNullifier: validity.noteNullifier,
      ownerCommitment: ownerCommitment(tradeIntent.owner),
      ownerCommitmentField: validity.ownerCommitmentField,
      proof: validity.proof,
      shareCommitment,
    },
    shareSets,
    validity,
  }) as unknown as IntentRecord;
}

async function closeLongTakeProfit(input: {
  aliceRecord: IntentRecord;
  asset: SupportedPerpAsset;
  batchId: string;
  entryPrice: bigint;
  fundingIndex: bigint;
  margin: bigint;
  marketId: string;
  priorPositionCommitments: Hex[];
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
  const currentPositionCommitments = [...input.priorPositionCommitments, ...positionCommitments];
  const position = settledLongPosition(input, positionCommitments, currentPositionCommitments);
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
  await post("/markets/update", {
    marketId: input.marketId,
    oraclePrice: markPrice,
    maxLeverage: input.asset.maxLeverage,
    initialMarginRate: input.asset.initialMarginRate,
    maintenanceMarginRate: input.asset.maintenanceMarginRate,
    fundingIndex: input.fundingIndex,
  });
  await post("/conditional-orders", {
    marketId: input.marketId,
    positionNullifier,
    closeCommitment,
  });
  const triggerRecord = clientProver.proveConditionalClose(witness);
  const triggerResponse = await post("/conditional-orders/trigger-proven", triggerRecord);
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
    owner: ownerCommitment(`${input.asset.symbol.toLowerCase()}-alice`),
    spendSecret: `${positionNullifier}:close-margin-spend`,
    rho: `${positionNullifier}:close-margin-rho`,
    blinding: `${positionNullifier}:close-margin-blinding`,
  });
  const provenClose = clientProver.provePositionClose({
    marketId: input.marketId,
    positionCommitment: position.position.commitment,
    positionRoot: position.membershipProof.root,
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
    newPositionRoot: position.newPositionRoot,
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
    pathIndices: position.membershipProof.indices,
    pathSiblings: position.membershipProof.siblings,
  });
  const closeResponse = await post("/position-closes/proven", provenClose);
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

function settledLongPosition(
  input: {
    aliceRecord: IntentRecord;
    asset: SupportedPerpAsset;
    entryPrice: bigint;
    fundingIndex: bigint;
    margin: bigint;
    marketId: string;
    size: bigint;
  },
  positionCommitments: Hex[],
  currentPositionCommitments: Hex[],
): {
  membershipProof: PositionMembershipProof;
  newPositionCommitment: Hex;
  newPositionRoot: Hex;
  newPosition: ReturnType<typeof createCircuitPositionNote>;
  position: ReturnType<typeof createCircuitPositionNote>;
} {
  if (positionCommitments.length === 0) {
    throw new Error("settlement did not create positions");
  }

  const fillIndex = 0;
  const owner = ownerCommitment(`${input.asset.symbol.toLowerCase()}-alice`);
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
    membershipProof: fieldMerkleProof(currentPositionCommitments, position.commitment as Hex),
    newPositionCommitment,
    newPositionRoot: fieldMerkleRoot([...currentPositionCommitments, newPositionCommitment]),
    newPosition,
    position,
  };
}

function parseHexList(value: unknown, field: string): Hex[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry) => String(entry) as Hex);
}

function loadKnownPositionCommitments(storePath: string): Hex[] {
  if (!storePath || !existsSync(storePath)) return [];
  return [...new FileProtocolStore(storePath).positionCommitments];
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
    owner: `${asset.symbol.toLowerCase()}-${owner}`,
    side,
    size,
    limitPrice,
    margin,
    noteNullifier,
    nonce: `${owner}-${batchId}`,
    salt: `${owner}-salt-${batchId}`,
  };
}

async function post(path: string, data: unknown): Promise<Record<string, unknown>> {
  const response = await app.handle(
    new Request(`http://merkl.local${path}`, {
      method: "POST",
      body: JSON.stringify(serialize(data)),
      headers: { "content-type": "application/json" },
    }),
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function postCreateOrRefreshMarket(data: Record<string, string>): Promise<Record<string, unknown>> {
  try {
    return await post("/markets/oracle", data);
  } catch (error) {
    if (!String((error as Error).message).includes("market already exists")) throw error;
    return post("/markets/oracle/refresh", {
      feedId: data.feedId,
      marketId: data.marketId,
    });
  }
}

function pushOnChain(context: MarketSmokeContext): Record<string, unknown> {
  console.error(`[smoke] ${context.asset.symbol}: pushing settlement on-chain`);
  const startedAt = Date.now();
  const deployment = readDeployment();
  const proof = context.settlement.proof as Record<string, string>;
  const batchKey = bytes32(hashFields("batch-id", [context.batchId]));
  const marketKey = bytes32(hashFields("market-id", [context.marketId]));
  const artifactDir = join(
    process.cwd(),
    "circuits/batch-match/target/bb",
    `batch-${hashFields("proof-artifact", [
      context.batchId,
      context.marketId,
      context.settlement.newRoot,
    ]).slice(2, 18)}`,
  );

  const oracleContract = activeOracleContract(deployment);
  assertPositionRootAligned(deployment, context);
  pushAdapterPrice(deployment, oracleContract, context);
  upsertMarket(deployment, marketKey, oracleContract, context.asset);

  submitIntent(deployment, context.aliceRecord);
  submitIntent(deployment, context.bobRecord);

  invoke(deployment.verifiers["batch-match-proof-verifier"], "verify_and_record", [
    "--public_inputs-file-path",
    join(artifactDir, "public_inputs"),
    "--proof_bytes-file-path",
    join(artifactDir, "proof"),
    "--public_input_hash",
    bytes32(proof.publicInputHash),
    "--proof_digest",
    bytes32(proof.proofDigest),
  ]);
  waitForProof(deployment, proof);

  invoke(deployment.contracts["batch-settlement"], "settle", [
    "--batch_id",
    batchKey,
    "--market_id",
    marketKey,
    "--old_root",
    bytes32(String(context.settlement.oldRoot)),
    "--new_root",
    bytes32(String(context.settlement.newRoot)),
    "--settlement_digest",
    bytes32(String(context.settlement.settlementDigest)),
    "--proof",
    JSON.stringify({
      circuit_hash: bytes32(proof.circuitHash),
      circuit_id: bytes32(proof.circuitKey),
      proof_digest: bytes32(proof.proofDigest),
      public_input_hash: bytes32(proof.publicInputHash),
      verifier_hash: bytes32(proof.verifierHash),
    }),
    "--filled_intents",
    JSON.stringify(
      (context.settlement.orderUpdates as Array<{ intentCommitment: string }>).map((update) =>
        bytes32(update.intentCommitment),
      ),
    ),
    "--new_commitments",
    JSON.stringify(
      (context.settlement.newCommitments as string[]).map((commitment) => bytes32(commitment)),
    ),
    "--margin_change_commitments",
    JSON.stringify(
      (context.settlement.marginChangeCommitments as string[]).map((commitment) =>
        bytes32(commitment),
      ),
    ),
    "--spent_nullifiers",
    JSON.stringify(
      (context.settlement.spentNullifiers as string[]).map((nullifier) => bytes32(nullifier)),
    ),
    "--volume",
    String(context.settlement.aggregateVolume),
    "--residual",
    String(context.settlement.residualSize),
  ]);

  waitForSettlement(deployment, batchKey, marketKey);
  pushCloseOnChain(deployment, oracleContract, marketKey, context);

  return {
    deployment: env.stellarDeploymentFile,
    batchSettlement: deployment.contracts["batch-settlement"],
    batchProofVerifier: deployment.verifiers["batch-match-proof-verifier"],
    oracleContract,
    oracleKind: env.oracleKind,
    oracleAsset:
      context.asset.oracleAssetType === "stellar"
        ? context.asset.oracleAssetAddress
        : context.asset.oracleAssetSymbol,
    closeSettled: "true",
    isSettled: "true",
    settlementMs: Date.now() - startedAt,
  };
}

function pushCloseOnChain(
  deployment: Deployment,
  oracleContract: string,
  marketKey: string,
  context: MarketSmokeContext,
): void {
  console.error(`[smoke] ${context.asset.symbol}: pushing conditional close on-chain`);
  const closePriceContext = {
    ...context,
    oraclePrice: context.close.markPrice,
    oraclePublishTime: Math.floor(Date.now() / 1000),
  };
  pushAdapterPrice(deployment, oracleContract, closePriceContext);
  upsertMarket(deployment, marketKey, oracleContract, context.asset);

  invoke(deployment.contracts["conditional-order"], "register", [
    "--market_id",
    marketKey,
    "--position_nullifier",
    bytes32(context.close.positionNullifier),
    "--close_commitment",
    bytes32(context.close.closeCommitment),
  ]);

  verifyAndRecord(
    deployment,
    "conditional-close-proof-verifier",
    context.close.conditionalClose.proof,
    proofArtifactDir("conditional-close", [
      context.close.positionNullifier,
      context.close.closeCommitment,
      context.close.markPrice,
    ]),
  );
  waitForProof(deployment, context.close.conditionalClose.proof);

  invoke(deployment.contracts["conditional-order"], "trigger", [
    "--market_id",
    marketKey,
    "--position_nullifier",
    bytes32(context.close.positionNullifier),
    "--close_commitment",
    bytes32(context.close.closeCommitment),
    "--mark_price",
    context.close.markPrice.toString(),
    "--proof",
    proofMetaArg(context.close.conditionalClose.proof),
  ]);

  verifyAndRecord(
    deployment,
    "position-close-proof-verifier",
    context.close.positionClose.proof,
    proofArtifactDir("position-close", [
      context.close.positionNullifier,
      context.close.closeCommitment,
      context.close.markPrice,
    ]),
  );
  waitForProof(deployment, context.close.positionClose.proof);

  invoke(deployment.contracts["position-close"], "settle", [
    "--market_id",
    marketKey,
    "--position_root",
    bytes32(context.close.positionClose.positionRoot),
    "--position_commitment",
    bytes32(context.close.positionClose.positionCommitment),
    "--position_nullifier",
    bytes32(context.close.positionClose.positionNullifier),
    "--close_commitment",
    bytes32(context.close.positionClose.closeCommitment),
    "--mark_price",
    context.close.positionClose.markPrice.toString(),
    "--new_position_commitment",
    bytes32(context.close.positionClose.newPositionCommitment),
    "--new_position_root",
    bytes32(context.close.positionClose.newPositionRoot),
    "--margin_output_commitment",
    bytes32(context.close.positionClose.marginOutputCommitment),
    "--proof",
    proofMetaArg(context.close.positionClose.proof),
  ]);

  waitForPositionClose(deployment, context.close.closeCommitment);
}

function activeOracleContract(deployment: Deployment): string {
  return env.oracleContractId || deployment.contracts["price-oracle"];
}

function pushAdapterPrice(
  deployment: Deployment,
  oracleContract: string,
  context: MarketSmokeContext,
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

function upsertMarket(
  deployment: Deployment,
  marketKey: string,
  oracleContract: string,
  asset: SupportedPerpAsset,
): void {
  if (!oracleContract) {
    throw new Error("missing ORACLE_CONTRACT_ID for on-chain SEP-40 oracle settlement");
  }
  const isStellarAsset = asset.oracleAssetType === "stellar";
  const oracleAsset = isStellarAsset ? asset.oracleAssetAddress : asset.oracleAssetSymbol;
  const isBeam = env.oracleKind === "beam";
  if (!oracleAsset) {
    throw new Error(`missing oracle asset for ${asset.symbol}`);
  }
  if (isBeam && !env.oracleBeamFeeToken) {
    throw new Error("missing ORACLE_BEAM_FEE_TOKEN for ReflectorBeam oracle settlement");
  }

  const method = isBeam
    ? isStellarAsset
      ? "upsert_beam_stellar"
      : "upsert_beam_other"
    : isStellarAsset
      ? "upsert_stellar"
      : "upsert_other";
  const args = [
    "--market_id",
    marketKey,
    "--oracle_contract",
    oracleContract,
    "--oracle_asset",
    oracleAsset,
  ];
  if (isBeam) {
    args.push("--beam_fee_token", env.oracleBeamFeeToken);
  } else {
    args.push("--oracle_kind", env.oracleKind);
  }
  args.push(
    "--oracle_max_age",
    String(env.oraclePriceMaxAgeSeconds),
    "--oracle_twap_records",
    String(env.oracleTwapRecords),
    "--price_decimals",
    String(env.oraclePriceDecimals),
    "--max_leverage",
    asset.maxLeverage.toString(),
    "--initial_rate",
    asset.initialMarginRate.toString(),
    "--maintenance_rate",
    asset.maintenanceMarginRate.toString(),
    "--funding_index",
    "0",
    "--active",
    "true",
  );

  invoke(deployment.contracts.market, method, args);
}

function submitIntent(deployment: Deployment, record: IntentRecord): void {
  invoke(deployment.contracts["intent-registry"], "submit", [
    "--batch_id",
    bytes32(hashFields("batch-id", [record.batchId])),
    "--market_id",
    bytes32(hashFields("market-id", [record.marketId])),
    "--intent_commitment",
    bytes32(record.intentCommitment),
    "--share_commitment",
    bytes32(record.shareCommitment),
  ]);
}

function waitForProof(deployment: Deployment, proof: Record<string, string>): void {
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

function verifyAndRecord(
  deployment: Deployment,
  verifierAuthority: string,
  proof: Record<string, string>,
  artifactDir: string,
): void {
  invoke(deployment.verifiers[verifierAuthority], "verify_and_record", [
    "--public_inputs-file-path",
    join(artifactDir, "public_inputs"),
    "--proof_bytes-file-path",
    join(artifactDir, "proof"),
    "--public_input_hash",
    bytes32(proof.publicInputHash),
    "--proof_digest",
    bytes32(proof.proofDigest),
  ]);
}

function proofArtifactDir(circuit: "conditional-close" | "position-close", fields: unknown[]): string {
  return join(
    process.cwd(),
    `circuits/${circuit}/target/bb`,
    `${circuit}-${hashFields("proof-artifact", fields).slice(2, 18)}`,
  );
}

function assertPositionRootAligned(deployment: Deployment, context: MarketSmokeContext): void {
  const chainRoot = currentPositionRoot(deployment);
  const localOldRoot = normalizeRoot(String(context.settlement.oldRoot));
  if (chainRoot === localOldRoot) return;

  throw new Error(
    [
      "local smoke position root does not match deployed position-state current_root",
      `market=${context.marketId}`,
      `batch=${context.batchId}`,
      `localOldRoot=${localOldRoot}`,
      `chainCurrentRoot=${chainRoot}`,
      `deployment=${env.stellarDeploymentFile}`,
      "Use the matching PROTOCOL_STORE_PATH/MERKL_SMOKE_RUNTIME_DIR, or deploy a fresh position-state/batch-settlement set before running a live smoke.",
    ].join("\n"),
  );
}

function currentPositionRoot(deployment: Deployment): Hex {
  const output = invoke(deployment.contracts["position-state"], "current_root", []);
  const root = output.match(/\b[0-9a-fA-F]{64}\b/)?.[0];
  if (!root) throw new Error(`could not parse position-state current_root\n${output}`);
  return normalizeRoot(root);
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
  const result = spawnSync("stellar", ["keys", "address", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0) {
    throw new Error(`could not resolve publisher source ${source}\n${output}`);
  }
  const address = output.match(/\bG[A-Z0-9]{55}\b/)?.[0];
  if (!address) throw new Error(`could not parse publisher address for ${source}`);
  return address;
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
  const send = new Set(["current_root", "has_proof", "is_settled"]).has(method) ? "no" : "yes";
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

function tradeSize(price: bigint): bigint {
  const targetNotionalUsd = 1_000n;
  const size = (targetNotionalUsd * PRICE_SCALE + price - 1n) / price;
  return size > 0n ? size : 1n;
}

function tradeNotional(size: bigint, price: bigint): bigint {
  return (size * price) / PRICE_SCALE;
}

function tradeMargin(size: bigint, price: bigint, leverage: bigint): bigint {
  return ceilDiv(tradeNotional(size, price), leverage);
}

function effectiveLeverageBps(notional: bigint, margin: bigint): bigint {
  if (margin === 0n) return 0n;
  return (notional * 10_000n) / margin;
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
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

function normalizeRoot(hex: string): Hex {
  return `0x${bytes32(hex).toLowerCase().padStart(64, "0")}` as Hex;
}

function proofMetaArg(proof: Record<string, string>): string {
  return JSON.stringify({
    circuit_hash: bytes32(proof.circuitHash),
    circuit_id: bytes32(proof.circuitKey),
    proof_digest: bytes32(proof.proofDigest),
    public_input_hash: bytes32(proof.publicInputHash),
    verifier_hash: bytes32(proof.verifierHash),
  });
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
