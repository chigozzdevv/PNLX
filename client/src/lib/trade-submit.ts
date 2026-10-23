import {
  prepareWalletAssetDeposit,
  signRelayAndFinalizePreparedDeposit,
} from "@/lib/custody-deposit";
import {
  defaultClientProofProvider,
  registerProofBundle,
  type ClientProofProvider,
  type IntentValidityRecord,
} from "@/lib/client-proof-provider";
import { storePendingConditionalStrategy as persistConditionalStrategy } from "@/lib/conditional-orders";
import { pnlxGet, pnlxPost, PnlxApiError } from "@/lib/pnlx-api";
import { createSecureMarginNote, randomLabel } from "@/lib/private-note";
import { backUpExistingPrivateMarginNotes, backUpPrivateMarginNote, unlockPrivateNoteBackup } from "@/lib/private-note-backup";
import { confirmRecoveredPrivateMarginDeposit } from "@/lib/deposit-recovery";
import {
  currentPrivateMarginNoteRuntimeScope,
  confirmPrivateMarginDeposit,
  lockPrivateMarginNote,
  markPrivateMarginNoteSpent,
  privateMarginNoteRuntimeScopeFromHealth,
  privateMarginNotes,
  planPrivateMarginNoteAllocations,
  reconcilePrivateMarginNotes,
  savePendingPrivateMarginChange,
  savePrivateMarginNote,
  setPrivateMarginNoteRuntimeScope,
  type PrivateMarginNoteAllocation,
} from "@/lib/private-margin-notes";
import { usdcToProtocolAmount } from "@/lib/asset-units";
import { RATE_SCALE, TAKER_FEE_PPM } from "@pnlx/market-math";
import type { Hex, MarketDisplay, ServerIntentRecord, ServerPortfolioSnapshot, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

const PRICE_SCALE = 100_000_000n;
const LEVERAGE_SCALE = 1_000_000n;
const PRIVATE_ORDER_MARGIN_ROUNDING_RESERVE = 32n;
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
  persistence?: {
    mongodb?: {
      collection?: string;
      database?: string;
    };
  };
  runtime?: {
    clientStorageScope?: string;
  };
  stellar?: {
    network?: string;
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
  intents: ServerIntentRecord[];
  protocolSize: bigint;
}

export interface DepositPrivateMarginInput {
  amount: number;
  collateralAsset: "USDC";
  onProgress?: (stage: TradeSubmitStage) => void;
  preferredNoteAmount?: number;
  proofProvider?: ClientProofProvider;
  session: WalletSession;
}

export interface DepositPrivateMarginResult {
  amount: bigint;
  commitment: Hex;
  commitments: Hex[];
  noteCount: number;
}

export async function submitTradeIntent(input: SubmitTradeIntentInput): Promise<SubmitTradeIntentResult> {
  markProgress(input, "hashing");
  const margin = usdcToProtocolAmount(input.margin, "Margin");
  const limitPrice = toPrice(input.limitPrice);
  const sizingPrice = input.sizingPrice ?? input.limitPrice;
  const entryPrice = toPrice(sizingPrice);
  const protocolSize = protocolOrderSize(margin, input.leverage, sizingPrice);
  if (protocolSize < 1n) {
    throw new Error("Increase private margin; this market currently requires at least 1 base contract");
  }
  if (input.leverage > input.market.maxLeverage) {
    throw new Error(`Max leverage for ${input.market.pair} is ${input.market.maxLeverage}x`);
  }
  const conditionalStrategy = normalizeConditionalStrategy(input, entryPrice);

  const health = await pnlxGet<HealthResponse>("/health", input.session.token);
  setPrivateMarginNoteRuntimeScope(privateMarginNoteRuntimeScopeFromHealth(health));
  await unlockPrivateNoteBackup(input.session);
  await backUpExistingPrivateMarginNotes(input.session);

  const notes = privateMarginNotes(input.session.ownerCommitment);
  const availableNotes = notes
    .filter((note) => note.status === "available")
    .filter((note) => !health.custody.collateralAsset.tokenDigest ||
      note.assetDigest === health.custody.collateralAsset.tokenDigest);
  const totalBalance = availableNotes.reduce((sum, note) => sum + BigInt(note.amount), 0n);
  if (totalBalance < margin) {
    const totalBalanceDisplay = Number(totalBalance) / 10_000_000;
    throw new Error(
      `Your spendable private balance is $${totalBalanceDisplay.toFixed(2)}. Deposit at least $${input.margin.toFixed(2)} before trading.`
    );
  }

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
  const note = await createSecureMarginNote({
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
    intents: [submittedIntent],
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
  let allocations = planPrivateMarginNoteAllocations({
    amount: input.marginProtocol,
    assetDigest: input.collateralTokenDigest,
    ownerCommitment: input.session.ownerCommitment,
  });
  let memberships: MarginMembershipResponse["note"][];
  try {
    memberships = await preflightMarginMemberships(allocations, input.session.token);
  } catch (error) {
    if (!isRecoverablePrivateMarginNoteError(error)) throw error;
    try {
      allocations = planPrivateMarginNoteAllocations({
        amount: input.marginProtocol,
        assetDigest: input.collateralTokenDigest,
        ownerCommitment: input.session.ownerCommitment,
      });
      memberships = await preflightMarginMemberships(allocations, input.session.token);
    } catch (retryError) {
      throw new Error(
        "Your private balance included notes that are no longer spendable. The balance has been refreshed; deposit the remaining amount before trading.",
        { cause: retryError },
      );
    }
  }
  const sizes = allocations.map((allocation) =>
    protocolOrderSize(allocation.amount, input.leverage, input.sizingPrice ?? input.limitPrice),
  );
  if (sizes.some((size) => size < 1n)) {
    throw new Error("A private balance input is too small for this order");
  }
  const submittedSize = sizes.reduce((sum, size) => sum + size, 0n);
  const groupId = `ui-${Date.now()}-${input.market.marketId}`;
  const submitted: ServerIntentRecord[] = [];

  try {
    for (const [index, allocation] of allocations.entries()) {
      submitted.push(await submitCustodyIntentFragment({
        ...input,
        allocation,
        batchId: `${groupId}-${index + 1}`,
        collateralTokenDigest: input.collateralTokenDigest,
        membership: memberships[index],
        protocolSize: sizes[index],
      }));
    }
  } catch (error) {
    const uncancelled = await cancelSubmittedIntentFragments(submitted, input.session.token);
    if (uncancelled.length > 0) {
      throw new Error(
        `Private order submission stopped after ${submitted.length} fragment(s), and ${uncancelled.length} could not be cancelled. Refresh Orders before trading again.`,
        { cause: error },
      );
    }
    throw error;
  }

  const first = submitted[0];
  if (!first) throw new Error("Private intent submission produced no orders");
  markProgress(input, "done");
  return {
    intent: first,
    intents: submitted,
    protocolSize: submittedSize,
  };
}

export async function submitCustodyIntentFragment(
  input: SubmitTradeIntentInput & {
    allocation: PrivateMarginNoteAllocation;
    batchId: string;
    collateralToken: string;
    collateralTokenDigest: Hex;
    conditionalStrategy: PendingConditionalStrategyInput | null;
    entryPriceProtocol: bigint;
    limitPriceProtocol: bigint;
    marginProtocol: bigint;
    membership: MarginMembershipResponse["note"];
    protocolSize: bigint;
  },
): Promise<ServerIntentRecord> {
  const proofProvider = input.proofProvider ?? defaultClientProofProvider();
  if (!proofProvider) throw new Error("Client proof provider is not configured");
  const { amount: margin, note } = input.allocation;
  let reservedIntentCommitment: Hex | undefined;
  let pendingChangeCommitment: Hex | undefined;
  if (!note.runtimeScope || note.runtimeScope !== currentPrivateMarginNoteRuntimeScope()) throw new Error("Private margin runtime changed before submission");
  try {
    const noteAmount = BigInt(note.amount);
    const changeAmount = noteAmount - margin;
    const changeNote = changeAmount > 0n
      ? await createSecureMarginNote({
          amount: changeAmount,
          assetDigest: note.assetDigest,
          blinding: randomLabel("change-blind"),
          owner: input.session.address,
          ownerDigest: note.ownerDigest,
          rho: randomLabel("change-rho"),
          spendSecret: randomLabel("change-spend"),
          spendSecretDigest: note.spendSecretDigest,
        })
      : undefined;
    markProgress(input, "proving");
    const intent = {
      batchId: input.batchId,
      limitPrice: input.limitPriceProtocol,
      margin,
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
        marginRoot: input.membership.membershipProof.root,
        marketId: intent.marketId,
        nonce: intent.nonce,
        noteAmount,
        noteChangeCommitment: changeNote?.commitment ?? ZERO_HEX,
        noteCommitment: note.commitment,
        noteNullifier: note.noteNullifier,
        owner: intent.owner,
        ownerDigest: note.ownerDigest,
        pathIndices: input.membership.membershipProof.indices,
        pathSiblings: input.membership.membershipProof.siblings,
        rhoDigest: note.rhoDigest,
        salt: intent.salt,
        side: intent.side,
        size: intent.size,
        spendSecretDigest: note.spendSecretDigest,
      }),
      input.session.token,
    );
    const validityRecord = normalizeIntentValidity(validity);
    if (note.runtimeScope !== currentPrivateMarginNoteRuntimeScope()) throw new Error("Private margin runtime changed during proving");
    const conditionalPolicy = prepareConditionalIntentPolicy(validityRecord.intentCommitment, input);
    if (changeNote) {
      const pending = savePendingPrivateMarginChange({
        amount: changeNote.amount.toString(), assetDigest: changeNote.assetDigest,
        blinding: changeNote.blinding, commitment: changeNote.commitment,
        noteNullifier: changeNote.noteNullifier, ownerCommitment: input.session.ownerCommitment,
        lockedByIntentCommitment: validityRecord.intentCommitment,
        runtimeScope: note.runtimeScope,
        noteFormat: "secure",
        ownerDigest: changeNote.ownerDigest, rhoDigest: changeNote.rhoDigest,
        spendSecretDigest: changeNote.spendSecretDigest, walletAddress: input.session.address,
      });
      pendingChangeCommitment = changeNote.commitment;
      await backUpPrivateMarginNote(pending, input.session);
    }
    lockPrivateMarginNote(note.commitment, validityRecord.intentCommitment);
    reservedIntentCommitment = validityRecord.intentCommitment;
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
        conditionalPolicy,
      },
      input.session.token,
    );
    const submittedIntent = intentRecordFromResponse(response);
    if (submittedIntent.intentCommitment.toLowerCase() !== validityRecord.intentCommitment.toLowerCase() ||
        submittedIntent.ownerCommitment.toLowerCase() !== input.session.ownerCommitment.toLowerCase() ||
        submittedIntent.marketId !== input.market.marketId) {
      throw new Error("Intent submission confirmation does not match the authorized order");
    }
    return submittedIntent;
  } catch (error) {
    if (note.runtimeScope !== currentPrivateMarginNoteRuntimeScope()) throw error;
    if (reservedIntentCommitment) {
      if (error instanceof PnlxApiError && error.submissionRejected) {
        reconcilePrivateMarginNotes({ orders: [{ intentCommitment: reservedIntentCommitment, status: "cancelled" }] });
      } else {
        await reconcileAmbiguousIntentSubmission(input.session, reservedIntentCommitment);
      }
    } else {
      if (pendingChangeCommitment) markPrivateMarginNoteSpent(pendingChangeCommitment);
      if (isRecoverablePrivateMarginNoteError(error)) markPrivateMarginNoteSpent(note.commitment);
    }
    throw error;
  }
}

async function reconcileAmbiguousIntentSubmission(session: WalletSession, intentCommitment: Hex): Promise<void> {
  try {
    const { portfolio } = await pnlxGet<{ portfolio: ServerPortfolioSnapshot }>(
      `/portfolio?ownerCommitment=${encodeURIComponent(session.ownerCommitment)}`, session.token,
    );
    if (portfolio.ownerCommitment.toLowerCase() !== session.ownerCommitment.toLowerCase()) return;
    const orders = portfolio.orders.filter((order) => order.intentCommitment.toLowerCase() === intentCommitment.toLowerCase());
    reconcilePrivateMarginNotes({ orders });
  } catch {
    // Absence or an unavailable service cannot prove an accepted intent was rejected.
  }
}

export async function depositPrivateMargin(input: DepositPrivateMarginInput): Promise<DepositPrivateMarginResult> {
  const amount = usdcToProtocolAmount(input.amount, "Collateral");
  const noteAmounts = splitDepositAmounts(amount, input.preferredNoteAmount);
  const proofProvider = input.proofProvider ?? defaultClientProofProvider();
  if (!proofProvider) throw new Error("Client proof provider is not configured");

  markProgress(input, "shielding");
  const health = await pnlxGet<HealthResponse>("/health", input.session.token);
  setPrivateMarginNoteRuntimeScope(privateMarginNoteRuntimeScopeFromHealth(health));
  await unlockPrivateNoteBackup(input.session);
  await backUpExistingPrivateMarginNotes(input.session);
  if (!health.custody.required) {
    throw new Error("Asset custody is not enabled");
  }
  if (!health.custody.collateralAsset.tokenContract) {
    throw new Error("Collateral token contract is not configured");
  }
  if (!health.custody.collateralAsset.tokenDigest) {
    throw new Error("Collateral token digest is not configured");
  }

  const commitments: Hex[] = [];
  for (const noteAmount of noteAmounts) {
    const prepared = await prepareWalletAssetDeposit({
      amount: noteAmount,
      assetDigest: health.custody.collateralAsset.tokenDigest,
      assetId: input.collateralAsset.toLowerCase(),
      proofProvider,
      session: input.session,
      token: health.custody.collateralAsset.tokenContract,
    });
    const pending = savePrivateMarginNote({
      amount: prepared.note.amount.toString(), assetDigest: prepared.note.assetDigest,
      blinding: prepared.note.blinding, commitment: prepared.note.commitment,
      noteNullifier: prepared.note.noteNullifier, ownerCommitment: input.session.ownerCommitment,
      noteFormat: "secure",
      ownerDigest: prepared.note.ownerDigest, rhoDigest: prepared.note.rhoDigest,
      spendSecretDigest: prepared.note.spendSecretDigest, walletAddress: input.session.address,
      status: "pending",
    });
    await backUpPrivateMarginNote(pending, input.session);
    markProgress(input, "signing");
    const finalized = await signRelayAndFinalizePreparedDeposit({
      prepared: prepared.prepared,
      session: input.session,
    });
    if (finalized.confirmedRecovery) await confirmRecoveredPrivateMarginDeposit(pending, input.session);
    else confirmPrivateMarginDeposit(pending);
    commitments.push(prepared.note.commitment);
  }
  markProgress(input, "done");

  return {
    amount,
    commitment: commitments[0],
    commitments,
    noteCount: commitments.length,
  };
}

export function splitDepositAmounts(amount: bigint, preferredNoteAmount?: number): bigint[] {
  void preferredNoteAmount;
  if (amount <= 0n) throw new Error("Deposit amount must be positive");
  return [amount];
}

async function preflightMarginMemberships(
  allocations: PrivateMarginNoteAllocation[],
  token?: string,
): Promise<MarginMembershipResponse["note"][]> {
  const results = await Promise.allSettled(
    allocations.map((allocation) => freshMarginMembership(allocation.note.commitment, token)),
  );
  let firstError: unknown;
  const memberships: MarginMembershipResponse["note"][] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      memberships[index] = result.value;
      continue;
    }
    firstError ??= result.reason;
    if (isRecoverablePrivateMarginNoteError(result.reason)) {
      markPrivateMarginNoteSpent(allocations[index].note.commitment);
    }
  }
  if (firstError) throw firstError;
  return memberships;
}

async function cancelSubmittedIntentFragments(
  submitted: ServerIntentRecord[],
  token?: string,
): Promise<ServerIntentRecord[]> {
  const uncancelled: ServerIntentRecord[] = [];
  for (const intent of [...submitted].reverse()) {
    try {
      await pnlxPost(
        "/orders/cancel",
        { intentCommitment: intent.intentCommitment },
        token,
      );
      reconcilePrivateMarginNotes({
        orders: [{ intentCommitment: intent.intentCommitment, status: "cancelled" }],
      });
    } catch {
      uncancelled.push(intent);
    }
  }
  return uncancelled;
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

function isRecoverablePrivateMarginNoteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return [
    "intent nullifier already spent",
    "local margin note is stale",
    "margin change commitment mismatch",
    "margin note commitment mismatch",
    "margin note not found",
    "margin note nullifier mismatch",
  ].some((needle) => message.includes(needle));
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

function normalizeIntentValidity(input: IntentValidityRecord): Omit<IntentValidityRecord, "currentBatch" | "expiryBatch"> & {
  currentBatch: bigint;
  expiryBatch: bigint;
} {
  return {
    ...input,
    currentBatch: BigInt(input.currentBatch),
    expiryBatch: BigInt(input.expiryBatch),
  };
}

async function freshMarginMembership(commitment: Hex, token?: string): Promise<MarginMembershipResponse["note"]> {
  try {
    const response = await pnlxGet<MarginMembershipResponse>(
      `/notes/membership?commitment=${encodeURIComponent(commitment)}`,
      token,
    );
    return response.note;
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("margin note not found")) {
      markPrivateMarginNoteSpent(commitment);
      throw new Error("That local margin note is stale for this runtime. It has been removed; deposit private USDC again.");
    }
    throw error;
  }
}

export function protocolOrderSize(margin: bigint, leverage: number, price: number): bigint {
  if (margin <= 0n || leverage <= 0 || price <= 0) return 0n;
  const effectiveMargin = margin > PRIVATE_ORDER_MARGIN_ROUNDING_RESERVE
    ? margin - PRIVATE_ORDER_MARGIN_ROUNDING_RESERVE
    : 0n;
  if (effectiveMargin === 0n) return 0n;
  const priceProtocol = toPrice(price);
  const leverageProtocol = BigInt(Math.round(leverage * Number(LEVERAGE_SCALE)));
  const notional = effectiveMargin * leverageProtocol * RATE_SCALE /
    (LEVERAGE_SCALE * RATE_SCALE + leverageProtocol * TAKER_FEE_PPM);
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
  prepareConditionalIntentPolicy(intentCommitment, input);
}

export interface ConditionalIntentPolicy {
  stopLossPrice?: string;
  stopLossSalt?: string;
  takeProfitPrice?: string;
  takeProfitSalt?: string;
}

export function prepareConditionalIntentPolicy(
  intentCommitment: Hex,
  input: SubmitTradeIntentInput & {
    conditionalStrategy: PendingConditionalStrategyInput | null;
    entryPriceProtocol: bigint;
    limitPriceProtocol: bigint;
    marginProtocol: bigint;
    protocolSize: bigint;
  },
): ConditionalIntentPolicy | undefined {
  if (typeof window === "undefined" || !input.conditionalStrategy) return undefined;
  const strategy = persistConditionalStrategy({
      entryLimitPrice: input.entryPriceProtocol.toString(),
      intentCommitment,
      leverage: input.leverage,
      margin: input.marginProtocol.toString(),
      marketId: input.market.marketId,
      ownerCommitment: input.session.ownerCommitment,
      side: input.side,
      size: input.protocolSize.toString(),
      stopLossPrice: input.conditionalStrategy.stopLossPrice?.toString() ?? null,
      takeProfitPrice: input.conditionalStrategy.takeProfitPrice?.toString() ?? null,
  });
  if (!strategy) throw new Error("Private conditional policy could not be persisted");
  return {
    stopLossPrice: strategy.stopLossPrice ?? undefined,
    stopLossSalt: strategy.stopLossSalt ?? undefined,
    takeProfitPrice: strategy.takeProfitPrice ?? undefined,
    takeProfitSalt: strategy.takeProfitSalt ?? undefined,
  };
}
