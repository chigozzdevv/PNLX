import {
  finalizeWalletAssetDeposit,
  prepareWalletAssetDeposit,
  signAndRelayPreparedDeposit,
} from "@/lib/custody-deposit";
import {
  defaultClientProofProvider,
  registerProofBundle,
  type ClientProofProvider,
} from "@/lib/client-proof-provider";
import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import { createCircuitMarginNote, randomLabel } from "@/lib/private-note";
import {
  buildSharedIntentPayload,
  getSharedIntentMpcConfig,
  type IntentValidityForSharedSubmit,
} from "@/lib/shared-intent";
import type { Hex, MarketDisplay, ServerIntentRecord, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

const PRICE_SCALE = 100_000_000;

export type TradeSubmitStage = "hashing" | "shielding" | "signing" | "proving" | "matching" | "done";

interface DepositNoteResponse {
  note: {
    commitment: Hex;
    membershipProof: {
      indices: boolean[];
      leaf: Hex;
      root: Hex;
      siblings: Hex[];
    };
    membershipRoot: Hex;
    marginRoot: Hex;
  };
}

interface ProveAndSubmitIntentResponse {
  intent: ServerIntentRecord;
}

type SharedIntentResponse = ServerIntentRecord | { intent: ServerIntentRecord };

interface HealthResponse {
  custody: {
    required: boolean;
    collateralAsset: {
      tokenContract: string;
      tokenDigest?: Hex;
    };
  };
}

export interface SubmitTradeIntentInput {
  collateralAsset: "USDC";
  leverage: number;
  limitPrice: number;
  margin: number;
  market: MarketDisplay;
  onProgress?: (stage: TradeSubmitStage) => void;
  proofProvider?: ClientProofProvider;
  session: WalletSession;
  side: Side;
  sizingPrice?: number;
  stopLossPrice?: number | null;
  takeProfitPrice?: number | null;
}

export interface SubmitTradeIntentResult {
  intent: ServerIntentRecord;
  protocolSize: bigint;
}

export async function submitTradeIntent(input: SubmitTradeIntentInput): Promise<SubmitTradeIntentResult> {
  markProgress(input, "hashing");
  const margin = toPositiveInteger(input.margin, "Private margin");
  const limitPrice = toPrice(input.limitPrice);
  const sizingPrice = input.sizingPrice ?? input.limitPrice;
  const entryPrice = toPrice(sizingPrice);
  const protocolSize = protocolSizeFromTicket(input.margin, input.leverage, sizingPrice);
  if (protocolSize < 1n) {
    throw new Error("Increase private margin; this market currently requires at least 1 base contract");
  }
  if (input.leverage > input.market.maxLeverage) {
    throw new Error(`Max leverage for ${input.market.pair} is ${input.market.maxLeverage}x`);
  }
  const conditionalStrategy = normalizeConditionalStrategy(input, entryPrice);

  const health = await pnlxGet<HealthResponse>("/health", input.session.token);
  if (health.custody.required) {
    return submitCustodySharedTradeIntent({
      ...input,
      collateralTokenDigest: health.custody.collateralAsset.tokenDigest,
      collateralToken: health.custody.collateralAsset.tokenContract,
      entryPriceProtocol: entryPrice,
      limitPriceProtocol: limitPrice,
      marginProtocol: margin,
      protocolSize,
      conditionalStrategy,
    });
  }

  return submitDevWitnessTradeIntent({
    ...input,
    entryPriceProtocol: entryPrice,
    limitPriceProtocol: limitPrice,
    marginProtocol: margin,
    protocolSize,
    conditionalStrategy,
  });
}

async function submitDevWitnessTradeIntent(
  input: SubmitTradeIntentInput & {
    limitPriceProtocol: bigint;
    entryPriceProtocol: bigint;
    marginProtocol: bigint;
    protocolSize: bigint;
    conditionalStrategy: PendingConditionalStrategyInput | null;
  },
): Promise<SubmitTradeIntentResult> {
  markProgress(input, "shielding");
  const note = await createCircuitMarginNote({
    amount: input.marginProtocol,
    assetId: input.collateralAsset.toLowerCase(),
    blinding: randomLabel("blind"),
    owner: input.session.address,
    rho: randomLabel("rho"),
    spendSecret: randomLabel("spend"),
  });
  const deposit = await pnlxPost<DepositNoteResponse>(
    "/notes/deposit",
    { commitment: note.commitment },
    input.session.token,
  );
  markProgress(input, "proving");
  const intent = {
    batchId: `ui-${Date.now()}-${input.market.marketId}`,
    limitPrice: input.limitPriceProtocol.toString(),
    margin: input.marginProtocol.toString(),
    marketId: input.market.marketId,
    nonce: randomLabel("nonce"),
    noteNullifier: note.noteNullifier,
    owner: input.session.address,
    salt: randomLabel("salt"),
    side: input.side,
    size: input.protocolSize.toString(),
  };
  const response = await pnlxPost<ProveAndSubmitIntentResponse>(
    "/intents/prove-and-submit",
    {
      ...intent,
      assetDigest: note.assetDigest,
      blinding: note.blinding,
      currentBatch: "1",
      expiryBatch: "2",
      marginRoot: deposit.note.membershipProof.root,
      noteAmount: note.amount.toString(),
      noteCommitment: note.commitment,
      ownerDigest: note.ownerDigest,
      pathIndices: deposit.note.membershipProof.indices,
      pathSiblings: deposit.note.membershipProof.siblings,
      rhoDigest: note.rhoDigest,
      spendSecretDigest: note.spendSecretDigest,
    },
    input.session.token,
  );
  const submittedIntent = intentRecordFromResponse(response);
  markProgress(input, "matching");

  storePrivateTradeNote({
    amount: input.marginProtocol.toString(),
    commitment: note.commitment,
    createdAt: Date.now(),
    intentCommitment: submittedIntent.intentCommitment,
    marketId: input.market.marketId,
    noteNullifier: note.noteNullifier,
    ownerCommitment: input.session.ownerCommitment,
  });
  storePendingConditionalStrategy(submittedIntent.intentCommitment, input);
  markProgress(input, "done");

  return {
    intent: submittedIntent,
    protocolSize: input.protocolSize,
  };
}

async function submitCustodySharedTradeIntent(
  input: SubmitTradeIntentInput & {
    collateralToken: string;
    collateralTokenDigest?: Hex;
    limitPriceProtocol: bigint;
    entryPriceProtocol: bigint;
    marginProtocol: bigint;
    protocolSize: bigint;
    conditionalStrategy: PendingConditionalStrategyInput | null;
  },
): Promise<SubmitTradeIntentResult> {
  const proofProvider = input.proofProvider ?? defaultClientProofProvider();
  if (!proofProvider) {
    throw new Error("Client proof provider is not configured");
  }
  if (!input.collateralToken) {
    throw new Error("Collateral token contract is not configured");
  }
  if (!input.collateralTokenDigest) {
    throw new Error("Collateral token digest is not configured");
  }

  markProgress(input, "shielding");
  const prepared = await prepareWalletAssetDeposit({
    amount: input.marginProtocol,
    assetDigest: input.collateralTokenDigest,
    assetId: input.collateralAsset.toLowerCase(),
    proofProvider,
    session: input.session,
    token: input.collateralToken,
  });
  markProgress(input, "signing");
  const relay = await signAndRelayPreparedDeposit({
    prepared: prepared.prepared,
    session: input.session,
  });
  const finalized = await finalizeWalletAssetDeposit({
    prepared: prepared.prepared,
    relay,
    session: input.session,
  });
  markProgress(input, "proving");
  const intent = {
    batchId: `ui-${Date.now()}-${input.market.marketId}`,
    limitPrice: input.limitPriceProtocol,
    margin: input.marginProtocol,
    marketId: input.market.marketId,
    nonce: randomLabel("nonce"),
    noteNullifier: prepared.note.noteNullifier,
    owner: input.session.address,
    salt: randomLabel("salt"),
    side: input.side,
    size: input.protocolSize,
  };
  const validity = await registerProofBundle(
    await proofProvider.intentValidity({
      assetDigest: prepared.note.assetDigest,
      batchId: intent.batchId,
      blinding: prepared.note.blinding,
      currentBatch: 1n,
      expiryBatch: 2n,
      limitPrice: intent.limitPrice,
      margin: intent.margin,
      marginRoot: finalized.membershipProof.root,
      marketId: intent.marketId,
      nonce: intent.nonce,
      noteAmount: prepared.note.amount,
      noteCommitment: prepared.note.commitment,
      noteNullifier: prepared.note.noteNullifier,
      owner: intent.owner,
      ownerDigest: prepared.note.ownerDigest,
      pathIndices: finalized.membershipProof.indices,
      pathSiblings: finalized.membershipProof.siblings,
      rhoDigest: prepared.note.rhoDigest,
      salt: intent.salt,
      side: intent.side,
      size: intent.size,
      spendSecretDigest: prepared.note.spendSecretDigest,
    }),
    input.session.token,
  );
  const payload = await buildSharedIntentPayload({
    intent,
    mpc: await getSharedIntentMpcConfig(input.session.token),
    validity: normalizeIntentValidity(validity),
  });
  markProgress(input, "matching");
  const response = await pnlxPost<SharedIntentResponse>(
    "/intents/shared",
    payload,
    input.session.token,
  );
  const submittedIntent = intentRecordFromResponse(response);

  storePrivateTradeNote({
    amount: input.marginProtocol.toString(),
    commitment: prepared.note.commitment,
    createdAt: Date.now(),
    intentCommitment: submittedIntent.intentCommitment,
    marketId: input.market.marketId,
    noteNullifier: prepared.note.noteNullifier,
    ownerCommitment: input.session.ownerCommitment,
  });
  storePendingConditionalStrategy(submittedIntent.intentCommitment, input);
  markProgress(input, "done");

  return {
    intent: submittedIntent,
    protocolSize: input.protocolSize,
  };
}

function intentRecordFromResponse(response: ProveAndSubmitIntentResponse | SharedIntentResponse): ServerIntentRecord {
  const candidate = response && typeof response === "object" && "intent" in response
    ? response.intent
    : response;
  if (!isIntentRecord(candidate)) {
    throw new Error("Intent submission returned an invalid response");
  }
  return candidate;
}

function isIntentRecord(value: unknown): value is ServerIntentRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "intentCommitment" in value &&
      typeof (value as { intentCommitment?: unknown }).intentCommitment === "string",
  );
}

function markProgress(input: Pick<SubmitTradeIntentInput, "onProgress">, stage: TradeSubmitStage): void {
  input.onProgress?.(stage);
}

interface PendingConditionalStrategyInput {
  stopLossPrice?: bigint;
  takeProfitPrice?: bigint;
}

function normalizeConditionalStrategy(
  input: SubmitTradeIntentInput,
  entryPrice: bigint,
): PendingConditionalStrategyInput | null {
  const takeProfitPrice = input.takeProfitPrice ? toPrice(input.takeProfitPrice) : undefined;
  const stopLossPrice = input.stopLossPrice ? toPrice(input.stopLossPrice) : undefined;
  if (!takeProfitPrice && !stopLossPrice) return null;

  if (takeProfitPrice) {
    const valid = input.side === "long" ? takeProfitPrice > entryPrice : takeProfitPrice < entryPrice;
    if (!valid) throw new Error("Take profit price is on the wrong side of entry");
  }
  if (stopLossPrice) {
    const valid = input.side === "long" ? stopLossPrice < entryPrice : stopLossPrice > entryPrice;
    if (!valid) throw new Error("Stop loss price is on the wrong side of entry");
  }

  return {
    stopLossPrice,
    takeProfitPrice,
  };
}

function normalizeIntentValidity(input: {
  batchDigest: Hex;
  currentBatch: string;
  expiryBatch: string;
  intentCommitment: Hex;
  marketDigest: Hex;
  marginRoot: Hex;
  noteCommitment: Hex;
  noteNullifier: Hex;
  ownerCommitmentField: Hex;
  proof: IntentValidityForSharedSubmit["proof"];
}): IntentValidityForSharedSubmit {
  return {
    ...input,
    currentBatch: BigInt(input.currentBatch),
    expiryBatch: BigInt(input.expiryBatch),
  };
}

function protocolSizeFromTicket(margin: number, leverage: number, price: number): bigint {
  if (margin <= 0 || leverage <= 0 || price <= 0) return 0n;
  return BigInt(Math.floor((margin * leverage) / price));
}

function toPositiveInteger(value: number, label: string): bigint {
  const rounded = BigInt(Math.round(value));
  if (rounded <= 0n) throw new Error(`${label} must be positive`);
  return rounded;
}

function toPrice(value: number): bigint {
  const scaled = BigInt(Math.round(value * PRICE_SCALE));
  if (scaled <= 0n) throw new Error("Price must be positive");
  return scaled;
}

function storePrivateTradeNote(note: {
  amount: string;
  commitment: Hex;
  createdAt: number;
  intentCommitment: Hex;
  marketId: string;
  noteNullifier: Hex;
  ownerCommitment: Hex;
}): void {
  if (typeof window === "undefined") return;
  const key = "pnlx.private.trade-notes";
  const existing = window.localStorage.getItem(key);
  const notes = existing ? JSON.parse(existing) as unknown[] : [];
  window.localStorage.setItem(key, JSON.stringify([...notes, note]));
}

function storePendingConditionalStrategy(
  intentCommitment: Hex,
  input: SubmitTradeIntentInput & {
    conditionalStrategy: PendingConditionalStrategyInput | null;
    entryPriceProtocol: bigint;
    limitPriceProtocol: bigint;
    marginProtocol: bigint;
    protocolSize: bigint;
  },
): void {
  if (typeof window === "undefined" || !input.conditionalStrategy) return;
  const key = "pnlx.private.conditional-strategies";
  const existing = window.localStorage.getItem(key);
  const strategies = existing ? JSON.parse(existing) as unknown[] : [];
  window.localStorage.setItem(key, JSON.stringify([
    ...strategies,
    {
      createdAt: Date.now(),
      entryLimitPrice: input.entryPriceProtocol.toString(),
      intentCommitment,
      leverage: input.leverage,
      margin: input.marginProtocol.toString(),
      marketId: input.market.marketId,
      ownerCommitment: input.session.ownerCommitment,
      side: input.side,
      size: input.protocolSize.toString(),
      status: "pending-position",
      stopLossPrice: input.conditionalStrategy.stopLossPrice?.toString() ?? null,
      takeProfitPrice: input.conditionalStrategy.takeProfitPrice?.toString() ?? null,
    },
  ]));
}
