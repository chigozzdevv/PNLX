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
  lockPrivateMarginNote,
  savePendingPrivateMarginChange,
  savePrivateMarginNote,
  selectPrivateMarginNote,
} from "@/lib/private-margin-notes";
import { usdcToProtocolAmount } from "@/lib/asset-units";
import type { Hex, MarketDisplay, ServerIntentRecord, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";
import type { ServerProofMeta } from "@/types/trading";

const PRICE_SCALE = 100_000_000n;
const LEVERAGE_SCALE = 1_000_000n;
const ZERO_HEX = "0x0" as Hex;

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

interface MarginMembershipResponse {
  note: DepositNoteResponse["note"] & {
    commitment: Hex;
    marginRoot: Hex;
    membershipRoot: Hex;
  };
}

interface ProveAndSubmitIntentResponse {
  intent: ServerIntentRecord;
}

type IntentSubmitResponse = ServerIntentRecord | { intent: ServerIntentRecord };

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

export interface DepositPrivateMarginInput {
  amount: number;
  collateralAsset: "USDC";
  onProgress?: (stage: TradeSubmitStage) => void;
  proofProvider?: ClientProofProvider;
  session: WalletSession;
}

export interface DepositPrivateMarginResult {
  amount: bigint;
  commitment: Hex;
}

export async function submitTradeIntent(input: SubmitTradeIntentInput): Promise<SubmitTradeIntentResult> {
  markProgress(input, "hashing");
  const margin = usdcToProtocolAmount(input.margin, "Margin");
  const limitPrice = toPrice(input.limitPrice);
  const sizingPrice = input.sizingPrice ?? input.limitPrice;
  const entryPrice = toPrice(sizingPrice);
  const protocolSize = protocolSizeFromTicket(margin, input.leverage, sizingPrice);
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
  const note = selectPrivateMarginNote({
    amount: input.marginProtocol,
    assetDigest: input.collateralTokenDigest,
    ownerCommitment: input.session.ownerCommitment,
  });
  const noteAmount = BigInt(note.amount);
  const changeAmount = noteAmount - input.marginProtocol;
  const changeNote = changeAmount > 0n
    ? await createCircuitMarginNote({
        amount: changeAmount,
        assetDigest: note.assetDigest,
        blinding: randomLabel("change-blind"),
        owner: input.session.address,
        rho: randomLabel("change-rho"),
        spendSecret: randomLabel("change-spend"),
      })
    : undefined;
  const membership = await freshMarginMembership(note.commitment, input.session.token);
  markProgress(input, "proving");
  const intent = {
    batchId: `ui-${Date.now()}-${input.market.marketId}`,
    limitPrice: input.limitPriceProtocol,
    margin: input.marginProtocol,
    marketId: input.market.marketId,
    nonce: randomLabel("nonce"),
    noteNullifier: note.noteNullifier,
    owner: input.session.address,
    salt: randomLabel("salt"),
    side: input.side,
    size: input.protocolSize,
  };
  const validity = await registerProofBundle(
    await proofProvider.intentValidity({
      assetDigest: note.assetDigest,
      batchId: intent.batchId,
      blinding: note.blinding,
      changeBlinding: changeNote?.blinding ?? ZERO_HEX,
      changeRhoDigest: changeNote?.rhoDigest ?? ZERO_HEX,
      currentBatch: 1n,
      expiryBatch: 2n,
      limitPrice: intent.limitPrice,
      margin: intent.margin,
      marginRoot: membership.membershipProof.root,
      marketId: intent.marketId,
      nonce: intent.nonce,
      noteAmount,
      noteChangeCommitment: changeNote?.commitment ?? ZERO_HEX,
      noteCommitment: note.commitment,
      noteNullifier: note.noteNullifier,
      owner: intent.owner,
      ownerDigest: note.ownerDigest,
      pathIndices: membership.membershipProof.indices,
      pathSiblings: membership.membershipProof.siblings,
      rhoDigest: note.rhoDigest,
      salt: intent.salt,
      side: intent.side,
      size: intent.size,
      spendSecretDigest: note.spendSecretDigest,
    }),
    input.session.token,
  );
  const validityRecord = normalizeIntentValidity(validity);
  markProgress(input, "matching");
  const response = await pnlxPost<IntentSubmitResponse>(
    "/intents",
    {
      intent: {
        ...intent,
        limitPrice: intent.limitPrice.toString(),
        margin: intent.margin.toString(),
        size: intent.size.toString(),
      },
      validity: {
        ...validityRecord,
        currentBatch: validityRecord.currentBatch.toString(),
        expiryBatch: validityRecord.expiryBatch.toString(),
      },
    },
    input.session.token,
  );
  const submittedIntent = intentRecordFromResponse(response);
  if (changeNote) {
    savePendingPrivateMarginChange({
      amount: changeNote.amount.toString(),
      assetDigest: changeNote.assetDigest,
      blinding: changeNote.blinding,
      commitment: changeNote.commitment,
      lockedByIntentCommitment: submittedIntent.intentCommitment,
      noteNullifier: changeNote.noteNullifier,
      ownerCommitment: input.session.ownerCommitment,
      ownerDigest: changeNote.ownerDigest,
      rhoDigest: changeNote.rhoDigest,
      spendSecretDigest: changeNote.spendSecretDigest,
      walletAddress: input.session.address,
    });
  }
  lockPrivateMarginNote(note.commitment, submittedIntent.intentCommitment);
  storePendingConditionalStrategy(submittedIntent.intentCommitment, input);
  markProgress(input, "done");

  return {
    intent: submittedIntent,
    protocolSize: input.protocolSize,
  };
}

export async function depositPrivateMargin(input: DepositPrivateMarginInput): Promise<DepositPrivateMarginResult> {
  const amount = usdcToProtocolAmount(input.amount, "Collateral");
  const proofProvider = input.proofProvider ?? defaultClientProofProvider();
  if (!proofProvider) throw new Error("Client proof provider is not configured");

  markProgress(input, "shielding");
  const health = await pnlxGet<HealthResponse>("/health", input.session.token);
  if (!health.custody.required) {
    throw new Error("Asset custody is not enabled");
  }
  if (!health.custody.collateralAsset.tokenContract) {
    throw new Error("Collateral token contract is not configured");
  }
  if (!health.custody.collateralAsset.tokenDigest) {
    throw new Error("Collateral token digest is not configured");
  }

  const prepared = await prepareWalletAssetDeposit({
    amount,
    assetDigest: health.custody.collateralAsset.tokenDigest,
    assetId: input.collateralAsset.toLowerCase(),
    proofProvider,
    session: input.session,
    token: health.custody.collateralAsset.tokenContract,
  });
  markProgress(input, "signing");
  const relay = await signAndRelayPreparedDeposit({
    prepared: prepared.prepared,
    session: input.session,
  });
  await finalizeWalletAssetDeposit({
    prepared: prepared.prepared,
    relay,
    session: input.session,
  });
  savePrivateMarginNote({
    amount: prepared.note.amount.toString(),
    assetDigest: prepared.note.assetDigest,
    blinding: prepared.note.blinding,
    commitment: prepared.note.commitment,
    noteNullifier: prepared.note.noteNullifier,
    ownerCommitment: input.session.ownerCommitment,
    ownerDigest: prepared.note.ownerDigest,
    rhoDigest: prepared.note.rhoDigest,
    spendSecretDigest: prepared.note.spendSecretDigest,
    walletAddress: input.session.address,
  });
  markProgress(input, "done");

  return {
    amount,
    commitment: prepared.note.commitment,
  };
}

function intentRecordFromResponse(response: ProveAndSubmitIntentResponse | IntentSubmitResponse): ServerIntentRecord {
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
  noteChangeCommitment: Hex;
  noteCommitment: Hex;
  noteNullifier: Hex;
  ownerCommitmentField: Hex;
  proof: ServerProofMeta;
}): {
  batchDigest: Hex;
  currentBatch: bigint;
  expiryBatch: bigint;
  intentCommitment: Hex;
  marketDigest: Hex;
  marginRoot: Hex;
  noteChangeCommitment: Hex;
  noteCommitment: Hex;
  noteNullifier: Hex;
  ownerCommitmentField: Hex;
  proof: ServerProofMeta;
} {
  return {
    ...input,
    currentBatch: BigInt(input.currentBatch),
    expiryBatch: BigInt(input.expiryBatch),
  };
}

async function freshMarginMembership(commitment: Hex, token?: string): Promise<MarginMembershipResponse["note"]> {
  const response = await pnlxGet<MarginMembershipResponse>(
    `/notes/membership?commitment=${encodeURIComponent(commitment)}`,
    token,
  );
  return response.note;
}

function protocolSizeFromTicket(margin: bigint, leverage: number, price: number): bigint {
  if (margin <= 0n || leverage <= 0 || price <= 0) return 0n;
  const priceProtocol = toPrice(price);
  const leverageProtocol = BigInt(Math.round(leverage * Number(LEVERAGE_SCALE)));
  const notional = (margin * leverageProtocol) / LEVERAGE_SCALE;
  const size = (notional * PRICE_SCALE) / priceProtocol;
  return size > 0n ? size : 0n;
}

function toPrice(value: number): bigint {
  const scaled = BigInt(Math.round(value * Number(PRICE_SCALE)));
  if (scaled <= 0n) throw new Error("Price must be positive");
  return scaled;
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
