import {
  prepareWalletAssetDeposit,
  signRelayAndFinalizePreparedDeposit,
} from "@/lib/custody-deposit";
import {
  defaultClientProofProvider,
  registerProofBundle,
  type ClientProofProvider,
  type IntentValidityRecord,
  type ProofBundle,
} from "@/lib/client-proof-provider";
import { storePendingConditionalStrategy as persistConditionalStrategy } from "@/lib/conditional-orders";
import { pnlxGet, pnlxPost, PnlxApiError } from "@/lib/pnlx-api";
import { createSecureMarginNote, digestToFieldHex, fieldHashPair, fieldHex, randomLabel } from "@/lib/private-note";
import { backUpExistingPrivateMarginNotes, backUpPrivateMarginNote, unlockPrivateNoteBackup } from "@/lib/private-note-backup";
import { confirmRecoveredPrivateMarginDeposit } from "@/lib/deposit-recovery";
import {
  currentPrivateMarginNoteRuntimeScope,
  confirmPrivateMarginDeposit,
  reservePrivateMarginNotes,
  releasePrivateMarginPreparation,
  markPrivateMarginSubmissionAttempted,
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
import { cancelOrder } from "@/lib/order-cancel";
import type { TradeIntent } from "@pnlx/protocol-types";

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

  const totalBalance = privateMarginNotes(input.session.ownerCommitment)
    .filter((note) => note.status === "available")
    .filter((note) => !health.custody.collateralAsset.tokenDigest || note.assetDigest === health.custody.collateralAsset.tokenDigest)
    .reduce((sum, note) => sum + BigInt(note.amount), 0n);
  if (totalBalance < margin) throw new Error("Deposit sufficient private USDC before trading");

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

export async function submitCustodySharedTradeIntent(
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
  return withWalletPreparation(input.session, () => submitCustodySharedTradeIntentUnlocked(input));
}

async function submitCustodySharedTradeIntentUnlocked(
  input: Parameters<typeof submitCustodySharedTradeIntent>[0],
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
  const plans = await Promise.all(allocations.map((allocation, index) => prepareCustodyIntentFragment({
    ...input, collateralTokenDigest: input.collateralTokenDigest!, allocation,
    batchId: `${groupId}-${index + 1}`, membership: memberships[index], protocolSize: sizes[index],
  })));
  reservePrivateMarginNotes(plans.map((plan) => ({ commitment: plan.input.allocation.note.commitment,
    intentCommitment: plan.intentCommitment })));

  try {
    for (const plan of plans) await persistPreparedChange(plan);
    const proofs = await provePreparedFragments(plans);
    for (const [index, plan] of plans.entries()) submitted.push(await submitPreparedCustodyFragment(plan, proofs[index]));
  } catch (error) {
    for (const plan of plans) releaseUnsubmittedPreparation(plan);
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
  return withWalletPreparation(input.session, async () => {
    const plan = await prepareCustodyIntentFragment(input);
    reservePrivateMarginNotes([{ commitment: plan.input.allocation.note.commitment, intentCommitment: plan.intentCommitment }]);
    try {
      await persistPreparedChange(plan);
      const proof = await provePreparedFragment(plan);
      return await submitPreparedCustodyFragment(plan, proof);
    } catch (error) {
      releaseUnsubmittedPreparation(plan);
      throw error;
    }
  });
}

type CustodyFragmentInput = Parameters<typeof submitCustodyIntentFragment>[0];
type PreparedCustodyFragment = {
  input: CustodyFragmentInput;
  intent: TradeIntent;
  intentCommitment: Hex;
  changeNote?: Awaited<ReturnType<typeof createSecureMarginNote>>;
  attempted: boolean;
  noteUnavailable: boolean;
  authoritativeActiveIntent?: Hex;
};

export async function custodyIntentCommitment(intent: TradeIntent, owner: Hex): Promise<Hex> {
  const [batch, market, nonce, salt] = await Promise.all([
    digestToFieldHex("pnlx:batch-id:" + intent.batchId), digestToFieldHex("pnlx:market-id:" + intent.marketId),
    digestToFieldHex("nonce:" + intent.nonce), digestToFieldHex("salt:" + intent.salt),
  ]);
  const scope = fieldHashPair(fieldHashPair(batch, market), fieldHashPair(fieldHex(BigInt(owner)), intent.side === "long" ? 1n : 2n));
  const economics = fieldHashPair(fieldHashPair(intent.size, intent.limitPrice), fieldHashPair(intent.margin, intent.noteNullifier));
  return fieldHashPair(fieldHashPair(scope, economics), fieldHashPair(nonce, salt));
}

async function prepareCustodyIntentFragment(original: CustodyFragmentInput): Promise<PreparedCustodyFragment> {
  const input = { ...original, session: { ...original.session }, market: { ...original.market },
    allocation: { ...original.allocation, note: { ...original.allocation.note } },
    membership: { ...original.membership, membershipProof: { ...original.membership.membershipProof,
      indices: [...original.membership.membershipProof.indices], siblings: [...original.membership.membershipProof.siblings] } } };
  const { amount: margin, note } = input.allocation;
  if (!note.runtimeScope || note.runtimeScope !== currentPrivateMarginNoteRuntimeScope() ||
    note.ownerCommitment.toLowerCase() !== input.session.ownerCommitment.toLowerCase() ||
    margin <= 0n || margin > BigInt(note.amount)) throw new Error("Private margin input changed before preparation");
  const changeAmount = BigInt(note.amount) - margin;
  const changeNote = changeAmount > 0n ? await createSecureMarginNote({ amount: changeAmount,
    assetDigest: note.assetDigest, blinding: randomLabel("change-blind"), owner: input.session.address,
    ownerDigest: note.ownerDigest, rho: randomLabel("change-rho"), spendSecret: randomLabel("change-spend"),
    spendSecretDigest: note.spendSecretDigest }) : undefined;
  const intent: TradeIntent = { batchId: input.batchId, limitPrice: input.limitPriceProtocol, margin,
    marketId: input.market.marketId, nonce: randomLabel("nonce"), noteNullifier: note.noteNullifier,
    owner: input.session.address, salt: randomLabel("salt"), side: input.side, size: input.protocolSize };
  return { input, intent, changeNote, intentCommitment: await custodyIntentCommitment(intent, input.session.ownerCommitment),
    attempted: false, noteUnavailable: false };
}

function assertPreparedReservation(plan: PreparedCustodyFragment): void {
  const note = plan.input.allocation.note;
  if (note.runtimeScope !== currentPrivateMarginNoteRuntimeScope()) throw new Error("Private margin runtime changed during preparation");
  const current = privateMarginNotes(plan.input.session.ownerCommitment).find((value) => value.commitment.toLowerCase() === note.commitment.toLowerCase());
  if (!current || current.status !== "locked" || !current.submissionPending || current.preparationOnly !== true ||
    current.lockedByIntentCommitment?.toLowerCase() !== plan.intentCommitment.toLowerCase() ||
    current.noteNullifier !== note.noteNullifier || current.amount !== note.amount) {
    throw new Error("Private margin input reservation changed during preparation");
  }
}

async function persistPreparedChange(plan: PreparedCustodyFragment): Promise<void> {
  assertPreparedReservation(plan);
  const { input, changeNote } = plan;
  if (!changeNote) return;
  const pending = savePendingPrivateMarginChange({ amount: changeNote.amount.toString(), assetDigest: changeNote.assetDigest,
    blinding: changeNote.blinding, commitment: changeNote.commitment, noteNullifier: changeNote.noteNullifier,
    ownerCommitment: input.session.ownerCommitment, lockedByIntentCommitment: plan.intentCommitment,
    runtimeScope: input.allocation.note.runtimeScope, noteFormat: "secure", ownerDigest: changeNote.ownerDigest,
    rhoDigest: changeNote.rhoDigest, spendSecretDigest: changeNote.spendSecretDigest, walletAddress: input.session.address });
  await backUpPrivateMarginNote(pending, input.session);
}

async function provePreparedFragment(plan: PreparedCustodyFragment): Promise<ProofBundle<IntentValidityRecord>> {
  assertPreparedReservation(plan);
  const { input, intent, changeNote } = plan;
  const note = input.allocation.note;
  const provider = input.proofProvider ?? defaultClientProofProvider();
  if (!provider) throw new Error("Client proof provider is not configured");
  markProgress(input, "proving");
  const proof = await provider.intentValidity({ assetDigest: note.assetDigest, batchId: intent.batchId,
    blinding: note.blinding, changeBlinding: changeNote?.blinding ?? ZERO_HEX, changeRhoDigest: changeNote?.rhoDigest ?? ZERO_HEX,
    currentBatch: 1n, expiryBatch: 2n, limitPrice: intent.limitPrice, margin: intent.margin,
    marginRoot: input.membership.membershipProof.root, marketId: intent.marketId, nonce: intent.nonce,
    noteAmount: BigInt(note.amount), noteChangeCommitment: changeNote?.commitment ?? ZERO_HEX,
    noteCommitment: note.commitment, noteNullifier: note.noteNullifier, owner: intent.owner, ownerDigest: note.ownerDigest,
    pathIndices: input.membership.membershipProof.indices, pathSiblings: input.membership.membershipProof.siblings,
    rhoDigest: note.rhoDigest, salt: intent.salt, side: intent.side, size: intent.size, spendSecretDigest: note.spendSecretDigest });
  assertPreparedReservation(plan);
  const record = proof.record;
  if (record.intentCommitment !== plan.intentCommitment || record.noteCommitment !== note.commitment ||
    record.noteNullifier !== note.noteNullifier || record.assetDigest !== note.assetDigest || record.ownerDigest !== note.ownerDigest ||
    record.marginRoot !== input.membership.membershipProof.root || record.noteChangeCommitment !== (changeNote?.commitment ?? ZERO_HEX) ||
    BigInt(record.currentBatch) !== 1n || BigInt(record.expiryBatch) !== 2n) {
    throw new Error("Intent validity proof does not match the reserved input");
  }
  return proof;
}

async function provePreparedFragments(plans: PreparedCustodyFragment[]): Promise<Array<ProofBundle<IntentValidityRecord>>> {
  const proofs: Array<ProofBundle<IntentValidityRecord>> = new Array(plans.length);
  let cursor = 0, failed = false;
  let failure: unknown;
  async function worker() {
    while (!failed) {
      const index = cursor++;
      if (index >= plans.length) return;
      try { proofs[index] = await provePreparedFragment(plans[index]); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, plans.length) }, () => worker()));
  if (failed) throw failure;
  return proofs;
}

async function checkPreparedInput(plan: PreparedCustodyFragment): Promise<void> {
  assertPreparedReservation(plan);
  const { note } = plan.input.allocation;
  let current: MarginMembershipResponse["note"];
  try { current = await freshMarginMembership(note.commitment, plan.input.session.token); }
  catch (error) {
    if (note.runtimeScope === currentPrivateMarginNoteRuntimeScope()) plan.noteUnavailable = isRecoverablePrivateMarginNoteError(error);
    throw error;
  }
  assertPreparedReservation(plan);
  if (current.membershipProof.root !== plan.input.membership.membershipProof.root) {
    throw new Error("Private collateral changed while proving; refresh and retry the order");
  }
  const status = await pnlxPost<{ notes: Array<{ commitment: Hex; known: boolean; spent: boolean; activeIntentCommitment?: Hex }> }>(
    "/notes/recovery-status", { notes: [{ commitment: note.commitment, nullifier: note.noteNullifier }] }, plan.input.session.token);
  assertPreparedReservation(plan);
  const own = status.notes?.find((value) => value.commitment.toLowerCase() === note.commitment.toLowerCase());
  if (!own || typeof own.known !== "boolean" || typeof own.spent !== "boolean") throw new Error("Private margin spend status is unavailable");
  if (!own.known || own.spent) { plan.noteUnavailable = true; throw new Error("Private margin input is no longer spendable"); }
  if (own.activeIntentCommitment && own.activeIntentCommitment.toLowerCase() !== plan.intentCommitment.toLowerCase()) {
    if (!/^0x[0-9a-f]+$/i.test(own.activeIntentCommitment)) throw new Error("Private margin spend status is unavailable");
    plan.authoritativeActiveIntent = own.activeIntentCommitment;
    throw new Error("Private margin input is reserved by another order");
  }
  assertPreparedReservation(plan);
}

async function submitPreparedCustodyFragment(plan: PreparedCustodyFragment, proof: ProofBundle<IntentValidityRecord>): Promise<ServerIntentRecord> {
  const { input, intent } = plan;
  const validityRecord = normalizeIntentValidity(proof.record);
  try {
    await registerProofBundle(proof, input.session.token);
    await checkPreparedInput(plan);
    const conditionalPolicy = prepareConditionalIntentPolicy(plan.intentCommitment, input);
    markPrivateMarginSubmissionAttempted(input.allocation.note.commitment, plan.intentCommitment);
    plan.attempted = true;
    markProgress(input, "matching");
    const response = await pnlxPost<IntentSubmitResponse>("/intents", { intent: { ...intent,
      limitPrice: intent.limitPrice.toString(), margin: intent.margin.toString(), size: intent.size.toString() },
      validity: { ...validityRecord, currentBatch: validityRecord.currentBatch.toString(), expiryBatch: validityRecord.expiryBatch.toString() },
      conditionalPolicy }, input.session.token);
    const submitted = intentRecordFromResponse(response);
    if (submitted.intentCommitment.toLowerCase() !== plan.intentCommitment.toLowerCase() ||
      submitted.ownerCommitment.toLowerCase() !== input.session.ownerCommitment.toLowerCase() || submitted.marketId !== input.market.marketId) {
      throw new Error("Intent submission confirmation does not match the authorized order");
    }
    return submitted;
  } catch (error) {
    if (input.allocation.note.runtimeScope !== currentPrivateMarginNoteRuntimeScope()) throw error;
    if (!plan.attempted) {
      releaseUnsubmittedPreparation(plan);
    } else if (error instanceof PnlxApiError && error.submissionRejected) {
      reconcilePrivateMarginNotes({ orders: [{ intentCommitment: plan.intentCommitment, status: "cancelled" }] });
    } else await reconcileAmbiguousIntentSubmission(input.session, plan.intentCommitment);
    throw error;
  }
}

function releaseUnsubmittedPreparation(plan: PreparedCustodyFragment): void {
  if (!plan.attempted) {
    releasePrivateMarginPreparation(plan.input.allocation.note.commitment, plan.intentCommitment,
      { runtimeScope: plan.input.allocation.note.runtimeScope, unavailable: plan.noteUnavailable,
        authoritativeActiveIntent: plan.authoritativeActiveIntent, ownerCommitment: plan.input.session.ownerCommitment });
  }
}

const preparingWallets = new Set<string>();
class PreparationBusyError extends Error {}

/** A reconnect may recover only work that provably never reached submission. */
export async function recoverAbandonedPrivateMarginPreparations(session: WalletSession): Promise<void> {
  try { await withWalletPreparation(session, async () => undefined); }
  catch (error) { if (!(error instanceof PreparationBusyError)) throw error; }
}

async function recoverAbandonedPreparationsInScope(session: WalletSession): Promise<void> {
  const scope = currentPrivateMarginNoteRuntimeScope();
  const pending = privateMarginNotes(session.ownerCommitment).filter((note) =>
    note.status === "locked" && note.submissionPending && note.preparationOnly === true && note.lockedByIntentCommitment);
  for (let index = 0; index < pending.length; index += 16) {
    const page = pending.slice(index, index + 16);
    const status = await pnlxPost<{ notes: Array<{ commitment: Hex; known: boolean; spent: boolean; activeIntentCommitment?: Hex }> }>(
      "/notes/recovery-status", { notes: page.map((note) => ({ commitment: note.commitment, nullifier: note.noteNullifier })) }, session.token);
    if (currentPrivateMarginNoteRuntimeScope() !== scope) throw new Error("Private margin runtime changed during preparation recovery");
    for (const note of page) {
      const current = status.notes?.find((value) => typeof value.commitment === "string" && value.commitment.toLowerCase() === note.commitment.toLowerCase());
      if (!current || current.known !== true || current.spent !== false || current.activeIntentCommitment !== undefined) continue;
      releasePrivateMarginPreparation(note.commitment, note.lockedByIntentCommitment!, { runtimeScope: scope });
    }
  }
}

async function withWalletPreparation<T>(session: WalletSession, work: () => Promise<T>): Promise<T> {
  const key = "pnlx.trade-preparation:" + currentPrivateMarginNoteRuntimeScope() + ":" + session.ownerCommitment.toLowerCase();
  if (preparingWallets.has(key)) throw new PreparationBusyError("Another private order is already being prepared");
  preparingWallets.add(key);
  try {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks) return await locks.request(key, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) throw new PreparationBusyError("Another private order is already being prepared");
      await recoverAbandonedPreparationsInScope(session);
      return work();
    });
    return await work();
  } finally { preparingWallets.delete(key); }
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
  const scope = currentPrivateMarginNoteRuntimeScope();
  const results = await Promise.allSettled(
    allocations.map((allocation) => freshMarginMembership(allocation.note.commitment, token)),
  );
  if (currentPrivateMarginNoteRuntimeScope() !== scope || allocations.some((allocation) => allocation.note.runtimeScope !== scope)) {
    throw new Error("Private margin runtime changed during membership preflight");
  }
  let firstError: unknown;
  const memberships: MarginMembershipResponse["note"][] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      memberships[index] = result.value;
      continue;
    }
    firstError ??= result.reason;
    if (isRecoverablePrivateMarginNoteError(result.reason)) {
      const expected = allocations[index].note;
      const current = privateMarginNotes(expected.ownerCommitment).find((note) => note.commitment === expected.commitment);
      if (current?.status === "available" && current.noteNullifier === expected.noteNullifier && current.amount === expected.amount) {
        markPrivateMarginNoteSpent(expected.commitment);
      }
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
      await cancelOrder({ intentCommitment: intent.intentCommitment, token });
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
  const response = await pnlxGet<MarginMembershipResponse>(
    `/notes/membership?commitment=${encodeURIComponent(commitment)}`, token,
  );
  return response.note;
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
