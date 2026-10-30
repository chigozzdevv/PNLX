/**
 * Real deployed-API adapter for the bounded observation run. No application runtime,
 * maker-note store, market mutation, oracle override, or funding reset is used here.
 *
 * All state is JSON serializable, and MUST be atomically encrypted by `persist`.
 * It contains spend authority, signed envelopes, and the account-event private key.
 * The runner must hold a process-wide lock while using an instance. Each submission
 * is durably marked before the request. Restarted/ambiguous submissions are observed
 * by their saved commitment/hash and are never automatically submitted again.
 */
import { createDecipheriv, createECDH, createHash, randomBytes } from "node:crypto";
import {
  commitIntent, digestToFieldHex, ownerCommitment, positionSecrets,
  secureMarginCommitment, secureMarginNullifier,
} from "@pnlx/crypto";
import { PRICE_SCALE, RATE_SCALE, settleClose, TAKER_FEE_PPM } from "@pnlx/market-math";
import { createCircuitPositionNote, createSecureMarginNote } from "@pnlx/sdk";
import type { AccountEventRecord, Hex, Side, TradeIntent } from "@pnlx/protocol-types";
import type { OwnerOrderSnapshot, OwnerPositionSnapshot } from "../../server/src/workers/indexer/indexer.model";
import {
  assertPositionOpeningAccountEvent, assertPositionCloseAccountEvent,
} from "../../server/src/shared/protocol/account-event-binding";

export const OBSERVATION_API_URL = "http://127.0.0.1:4000";
export const OBSERVATION_NETWORK = "Test SDF Network ; September 2015";
export const OBSERVATION_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const OBSERVATION_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ZERO: Hex = "0x0";
type JsonObject = Record<string, any>;
type NoteStatus = "pending" | "available" | "locked" | "spent";
export interface ProtocolIdentity {
  source: string;
  address: string;
  /** Base64 Ed25519 signature over the Stellar signed-message hash. */
  signMessage(message: string): Promise<string>;
  /** Sign only with this trader's supplied Stellar source alias. */
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
}
export interface ProtocolSession {
  address: string; ownerCommitment: Hex; token: string; expiresAt: number; networkPassphrase: string;
}
export interface PrivateNote {
  amount: string; assetDigest: Hex; blinding: Hex; commitment: Hex;
  noteNullifier: Hex; ownerDigest: Hex; rhoDigest: Hex; spendSecretDigest: Hex;
  ownerCommitment: Hex; walletAddress: string; status: NoteStatus;
  lockedByIntentCommitment?: Hex; depositTxHash?: string;
}
export interface DepositState {
  id: string; amount: string; commitment: Hex;
  phase: "preparing" | "ready" | "submitting" | "uncertain" | "confirmed";
  prepared?: JsonObject; signedXdr?: string; relay?: JsonObject;
  txHash?: string; createdAt: number; confirmedAt?: number; error?: string;
}
export interface PositionOpening {
  entryFee?: string; entryPrice: string; fundingIndex: string; margin: string;
  marketId: string; positionCommitment: Hex; positionNullifier: Hex;
  ownerDigest: Hex; positionSeed: Hex; fillIndex: number;
  side: Side; size: string; sourceIntentCommitment: Hex;
}
export interface CloseAttempt {
  phase: "ready" | "submitting" | "uncertain" | "context-rejected" | "confirmed";
  closeCommitment: Hex; witness: JsonObject; output: PrivateNote;
  createdAt: number; submittedAt?: number; confirmedAt?: number;
  settlementTxHash?: string; response?: JsonObject; error?: string;
  markPrice: string; fundingIndex: string; fundingPayment: string;
  realizedPnl: string; returnedMargin: string;
}
export interface ObservedPosition {
  snapshot: OwnerPositionSnapshot; opening: PositionOpening; closes: CloseAttempt[];
  /** The actual winning close, recovered from the owner-bound encrypted event. */
  confirmedClose?: JsonObject & ConfirmedCloseAccounting;
}
export interface ConfirmedCloseAccounting {
  /** Opening fill fee, when supplied by the encrypted opening; negative = rebate. */
  entryFee?: string;
  /** The confirmed position-close-pair circuit requires this to be zero. */
  closeFee: string;
  totalFees?: string;
  /** Positive is paid by this position; negative is funding received. */
  fundingPayment: string;
  grossPricePnl: string;
  returnedMargin: string;
  /** Original allocated collateral before the opening fee/rebate. */
  allocatedMargin?: string;
  /** Actual returned cash minus original allocated collateral, including fees. */
  netPnl?: string;
  /** Difference between actual payout and equity; retains paired floor/cap effects. */
  pairedPayoutAdjustment: string;
  payoutCapped: boolean;
  accountingComplete: boolean;
}
export interface OpenSpec {
  id: string; marketId: string; margin: string; leverage: number; side: Side;
  /** Limit bound around the existing real oracle; default 100 bps, maximum 200. */
  limitSlippageBps?: number;
}
export interface CycleState {
  id: string; spec: OpenSpec;
  phase: "preparing" | "ready" | "submitting" | "uncertain" | "accepted" | "open" | "closing" | "closed" | "cancelled";
  noteCommitment: Hex; changeCommitment?: Hex; intentCommitment: Hex;
  intent: JsonObject; validity?: JsonObject; submitted?: JsonObject;
  oraclePriceAtPreparation: string; fundingIndexAtPreparation: string;
  positions: ObservedPosition[]; orders: OwnerOrderSnapshot[];
  activeOrders: OwnerOrderSnapshot[];
  cancellations?: Record<string, { phase: "submitting" | "uncertain" | "confirmed"; submittedAt: number; txHash?: string; error?: string }>;
  refunds?: Record<string, { phase: "preparing" | "ready" | "submitting" | "uncertain" | "confirmed" | "zero";
    noteCommitment?: Hex; amount: string; proof?: JsonObject; txHash?: string; error?: string }>;
  cashReconciled?: boolean;
  matching: Array<{ observedAt: number; intentCommitment: Hex; matching: OwnerOrderSnapshot["matching"] }>;
  timings: Record<string, number>; error?: string;
}
export interface ProtocolState {
  version: 1; source: string; address: string; ownerCommitment: Hex;
  runtimeScope?: string; networkPassphrase?: string; collateralToken?: string; collateralDigest?: Hex;
  accountKey?: { privateKey: string; publicKey: string };
  notes: PrivateNote[]; deposits: Record<string, DepositState>; cycles: Record<string, CycleState>;
  requests: Array<{ at: number; path: string; method: string; ms: number; status?: number }>;
}
export interface ProtocolOptions {
  identity: ProtocolIdentity;
  /** Resolves only after durable atomic encryption; rejection prevents submission. */
  persist(state: ProtocolState): Promise<void>;
  state?: ProtocolState;
  apiUrl?: string;
  /** Existing action-proof service, same contract as the web client provider. */
  proverUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
}
export class ProtocolApiError extends Error {
  constructor(readonly path: string, readonly status: number, readonly detail: string) {
    super(`PNLX ${path} returned ${status}: ${detail}`);
  }
}

export class ObservationProtocol {
  private readonly data: ProtocolState;
  private session?: ProtocolSession;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly apiUrl: string;
  private readonly proverUrl: string;
  private busy = false;

  constructor(private readonly options: ProtocolOptions) {
    this.apiUrl = (options.apiUrl ?? OBSERVATION_API_URL).replace(/\/$/, "");
    if (this.apiUrl !== OBSERVATION_API_URL) throw new Error("Observation must use the deployed VPS API at http://127.0.0.1:4000");
    this.proverUrl = (options.proverUrl ?? "http://127.0.0.1:4101").replace(/\/$/, "");
    const prover = new URL(this.proverUrl);
    if (prover.username || prover.password || prover.search || prover.hash ||
      (prover.protocol !== "https:" && !(prover.protocol === "http:" && ["127.0.0.1", "localhost"].includes(prover.hostname)))) {
      throw new Error("Action prover must use HTTPS or a loopback HTTP service");
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    const owner = ownerCommitment(options.identity.address);
    const state = options.state;
    if (state && (state.version !== 1 || state.address !== options.identity.address || state.source !== options.identity.source || !same(state.ownerCommitment, owner))) {
      throw new Error("Observation state does not belong to the supplied trader identity");
    }
    this.data = clone(state ?? { version: 1, source: options.identity.source, address: options.identity.address,
      ownerCommitment: owner, notes: [], deposits: {}, cycles: {}, requests: [] });
  }

  /** Returns a detached PRIVATE snapshot. Do not log or place in an email/report. */
  get state(): ProtocolState { return clone(this.data); }

  async authenticate(): Promise<ProtocolSession> {
    if (this.session && this.session.expiresAt > this.now() + 60_000) return this.session;
    const challenge = await this.request<JsonObject>("/auth/challenge", { address: this.data.address }, false);
    if (challenge.address !== this.data.address || !same(challenge.ownerCommitment, this.data.ownerCommitment) ||
      challenge.signingMode !== "stellar-ed25519-message" || challenge.expiresAt <= this.now() ||
      typeof challenge.message !== "string" || challenge.networkPassphrase !== OBSERVATION_NETWORK ||
      (this.data.networkPassphrase && this.data.networkPassphrase !== challenge.networkPassphrase)) {
      throw new Error("Authentication challenge does not match the observation identity/network");
    }
    const signature = await this.options.identity.signMessage(challenge.message);
    const session = await this.request<ProtocolSession & { networkPassphrase: string }>("/auth/session", {
      address: this.data.address, nonce: challenge.nonce, signature,
    }, false);
    if (session.address !== this.data.address || !same(session.ownerCommitment, this.data.ownerCommitment) ||
      session.networkPassphrase !== challenge.networkPassphrase || session.expiresAt <= this.now()) {
      throw new Error("Authenticated session does not match the observation trader");
    }
    this.session = session;
    return session;
  }

  async prepareDeposit(id: string, amount: string): Promise<DepositState> {
    return this.exclusive(async () => {
      positive(amount, "deposit amount"); validateId(id);
      await this.readiness();
      let deposit = this.data.deposits[id];
      if (deposit) {
        if (deposit.amount !== amount) throw new Error("Deposit id already has a different amount");
        if (deposit.phase !== "preparing") return clone(deposit);
      } else {
        const note = this.newNote(BigInt(amount));
        this.data.notes.push(note);
        deposit = this.data.deposits[id] = { id, amount, commitment: note.commitment, phase: "preparing", createdAt: this.now() };
        await this.save();
      }
      const note = this.note(deposit.commitment);
      const proof = await this.prove("/secure-deposit-note", {
        amount, blinding: note.blinding, commitment: note.commitment, ownerDigest: note.ownerDigest,
        rhoDigest: note.rhoDigest, spendSecretDigest: note.spendSecretDigest, tokenDigest: note.assetDigest,
      });
      if (!same(proof.commitment, note.commitment) || proof.amount !== amount || !same(proof.tokenDigest, note.assetDigest)) throw new Error("Deposit proof binding mismatch");
      // Preparation can relay proof verification, so the note opening is durable first.
      const prepared = await this.request<JsonObject>("/notes/deposit-asset/prepare-proven", {
        amount, commitment: note.commitment, depositProof: proof, from: this.data.address, token: this.data.collateralToken,
      });
      if (!same(prepared.pendingDeposit?.commitment, note.commitment) || prepared.pendingDeposit?.from !== this.data.address ||
        prepared.pendingDeposit?.amount !== amount || prepared.pendingDeposit?.token !== this.data.collateralToken ||
        !same(prepared.pendingDeposit?.tokenDigest, note.assetDigest) || !prepared.action?.xdr ||
        !prepared.pendingDeposit?.preparedTxHash || prepared.action?.functionName !== "deposit_asset_secure") {
        throw new Error("Prepared deposit does not match the trader note");
      }
      deposit.prepared = prepared; deposit.txHash = prepared.pendingDeposit.preparedTxHash; deposit.phase = "ready";
      await this.save();
      return clone(deposit);
    });
  }

  async submitDeposit(id: string): Promise<DepositState> {
    return this.exclusive(async () => {
      const deposit = this.deposit(id);
      if (deposit.phase === "confirmed") return clone(deposit);
      if (deposit.phase === "submitting" || deposit.phase === "uncertain") return this.reconcileDepositInternal(deposit);
      if (deposit.phase !== "ready" || !deposit.prepared) throw new Error("Prepare the deposit first");
      await this.readiness();
      deposit.signedXdr = await this.options.identity.signTransaction(deposit.prepared.action.xdr, this.data.networkPassphrase!);
      deposit.phase = "submitting";
      await this.save(); // The exact signed envelope/hash exists before custody submission.
      try {
        const { relay } = await this.request<{ relay: JsonObject }>("/relays/signed-xdr", {
          commitment: deposit.commitment, expectedTxHash: deposit.txHash,
          preparedXdrDigest: deposit.prepared.pendingDeposit.preparedXdrDigest, xdr: deposit.signedXdr,
        });
        if (!same(relay.txHash, deposit.txHash) || !relay.relayId) throw new Error("Deposit relay confirmation mismatch");
        deposit.relay = relay; await this.save();
        await this.request("/notes/deposit-asset/finalize", {
          amount: deposit.amount, commitment: deposit.commitment, depositProof: deposit.prepared.depositProof,
          from: this.data.address, relayId: relay.relayId, token: this.data.collateralToken,
        });
      } catch (error) {
        deposit.phase = "uncertain"; deposit.error = safeError(error); await this.save();
      }
      return this.reconcileDepositInternal(deposit);
    });
  }

  async reconcileDeposit(id: string): Promise<DepositState> {
    return this.exclusive(() => this.reconcileDepositInternal(this.deposit(id)));
  }

  async prepareOpen(spec: OpenSpec): Promise<CycleState> {
    return this.exclusive(async () => {
      validateId(spec.id); positive(spec.margin, "margin");
      if (!["100000000", "250000000", "500000000", "1000000000"].includes(spec.margin)) throw new Error("Observation margin must be 10, 25, 50 or 100 USDC");
      if (!["btc-usd-perp", "eth-usd-perp", "xlm-usd-perp"].includes(spec.marketId)) throw new Error("Observation market must be BTC, ETH or XLM");
      if (!Number.isInteger(spec.leverage) || ![1, 2, 3, 5, 8].includes(spec.leverage)) throw new Error("Observation leverage is outside the approved sequence");
      if (!["long", "short"].includes(spec.side)) throw new Error("Invalid trade side");
      const slippage = spec.limitSlippageBps ?? 100;
      if (!Number.isInteger(slippage) || slippage < 0 || slippage > 200) throw new Error("Limit slippage must be 0-200 bps");
      await this.readiness(); await this.ensureAccountKey();
      let cycle = this.data.cycles[spec.id];
      if (cycle) {
        if (cycle.spec.marketId !== spec.marketId || cycle.spec.margin !== spec.margin || cycle.spec.leverage !== spec.leverage ||
          cycle.spec.side !== spec.side || (cycle.spec.limitSlippageBps ?? 100) !== slippage) throw new Error("Cycle id already has a different specification");
        if (cycle.phase !== "preparing") return clone(cycle);
      } else {
        if (Object.values(this.data.cycles).some((item) => !["closed", "cancelled"].includes(item.phase) || item.cashReconciled !== true)) throw new Error("Resolve the existing observation cycle before opening another");
        const markets = (await this.request<{ markets: JsonObject[] }>("/markets")).markets;
        const market = markets.find((entry) => entry.marketId === spec.marketId);
        if (!market) throw new Error("Observation market is unavailable");
        if (BigInt(spec.leverage) > BigInt(market.maxLeverage)) throw new Error("Requested leverage exceeds the deployed market maximum");
        const oracle = positive(String(market.oraclePrice), "oracle price");
        const limitPrice = oracle * BigInt(10_000 + (spec.side === "long" ? slippage : -slippage)) / 10_000n;
        // Use the more conservative price for size and account for the taker fee.
        const sizingPrice = limitPrice > oracle ? limitPrice : oracle;
        const size = observationOrderSize(BigInt(spec.margin), spec.leverage, sizingPrice);
        if (size <= 0n) throw new Error("Requested margin is too small for this market");
        if (size * limitPrice / PRICE_SCALE * BigInt(market.initialMarginRate) / RATE_SCALE > BigInt(spec.margin)) throw new Error("Requested leverage exceeds the deployed initial margin rule");
        const note = this.data.notes.filter((entry) => entry.status === "available" &&
          same(entry.assetDigest, this.data.collateralDigest) && same(entry.ownerCommitment, this.data.ownerCommitment) &&
          entry.walletAddress === this.data.address && BigInt(entry.amount) >= BigInt(spec.margin))
          .sort((a, b) => BigInt(a.amount) < BigInt(b.amount) ? -1 : 1)[0];
        if (!note) throw new Error("No single confirmed private trader note can fund this margin");
        assertNote(note, this.data);
        const intent: TradeIntent = { batchId: `observation-${spec.id}`, marketId: spec.marketId, side: spec.side,
          size, margin: BigInt(spec.margin), limitPrice, noteNullifier: note.noteNullifier,
          owner: this.data.address, nonce: random(), salt: random() };
        const intentCommitment = commitIntent(intent);
        const changeAmount = BigInt(note.amount) - BigInt(spec.margin);
        const change = changeAmount > 0n ? this.newNote(changeAmount, note) : undefined;
        if (change) { change.lockedByIntentCommitment = intentCommitment; this.data.notes.push(change); }
        note.status = "locked"; note.lockedByIntentCommitment = intentCommitment;
        cycle = this.data.cycles[spec.id] = { id: spec.id, spec: clone(spec), phase: "preparing",
          noteCommitment: note.commitment, changeCommitment: change?.commitment, intentCommitment,
          intent: clone(intent), oraclePriceAtPreparation: oracle.toString(), fundingIndexAtPreparation: String(market.fundingIndex),
          positions: [], orders: [], activeOrders: [], matching: [], timings: { preparationStartedAt: this.now() } };
        await this.save();
      }
      const note = this.note(cycle.noteCommitment); assertNote(note, this.data);
      const membership = await this.membership(note.commitment);
      const change = cycle.changeCommitment ? this.note(cycle.changeCommitment) : undefined;
      const validity = await this.prove("/intent-validity", { ...cycle.intent,
        assetDigest: note.assetDigest, blinding: note.blinding,
        changeBlinding: change?.blinding ?? ZERO, changeRhoDigest: change?.rhoDigest ?? ZERO,
        currentBatch: "1", expiryBatch: "2", marginRoot: membership.root,
        noteAmount: note.amount, noteChangeCommitment: change?.commitment ?? ZERO,
        noteCommitment: note.commitment, ownerDigest: note.ownerDigest,
        pathIndices: membership.indices, pathSiblings: membership.siblings,
        rhoDigest: note.rhoDigest, spendSecretDigest: note.spendSecretDigest,
      });
      if (!same(validity.intentCommitment, cycle.intentCommitment) || !same(validity.noteCommitment, note.commitment) ||
        !same(validity.noteNullifier, note.noteNullifier) || !same(validity.ownerDigest, note.ownerDigest) ||
        !same(validity.noteChangeCommitment, change?.commitment ?? ZERO) || !validity.positionSeed) throw new Error("Intent proof does not match the persisted authorized order");
      cycle.validity = validity; cycle.phase = "ready"; cycle.timings.preparedAt = this.now();
      await this.save(); return clone(cycle);
    });
  }

  async open(id: string): Promise<CycleState> {
    return this.exclusive(async () => {
      const cycle = this.cycle(id);
      if (cycle.phase !== "ready") return this.pollCycle(cycle);
      if (!cycle.validity) throw new Error("Prepare the intent first");
      await this.readiness();
      cycle.phase = "submitting"; cycle.timings.submissionStartedAt = this.now(); await this.save();
      try {
        const result = await this.request<JsonObject>("/intents", { intent: cycle.intent, validity: cycle.validity });
        const intent = result.intent ?? result;
        if (!same(intent.intentCommitment, cycle.intentCommitment) || !same(intent.ownerCommitment, this.data.ownerCommitment) || intent.marketId !== cycle.spec.marketId) throw new Error("Intent submission confirmation mismatch");
        cycle.submitted = intent; cycle.phase = "accepted"; cycle.timings.acceptedAt = this.now(); await this.save();
      } catch (error) { cycle.phase = "uncertain"; cycle.error = safeError(error); await this.save(); }
      return this.pollCycle(cycle);
    });
  }

  /** Poll once; scheduler controls cadence/deadline. Includes actual matcher run/phase. */
  async pollOpen(id: string): Promise<CycleState> { return this.exclusive(() => this.pollCycle(this.cycle(id))); }
  async pollClose(id: string): Promise<CycleState> { return this.exclusive(() => this.pollCycle(this.cycle(id))); }

  /** Cancel only this cycle's active leaf orders; return confirmed private collateral.
   * A missing cancellation/claim response is never automatically resubmitted.
   * Existing positions remain open/closing until their paired closes reconcile.
   */
  async cancelOpen(id: string): Promise<CycleState> {
    return this.exclusive(async () => {
      const cycle = this.cycle(id); await this.pollCycle(cycle); await this.readiness();
      cycle.cancellations ??= {};
      for (const order of activeObservationOrders(cycle.orders)) {
        const key = order.intentCommitment.toLowerCase();
        if (cycle.cancellations[key]) continue;
        cycle.cancellations[key] = { phase: "submitting", submittedAt: this.now() };
        await this.save();
        try {
          const result = await this.request<{ order: JsonObject }>("/orders/cancel", { intentCommitment: order.intentCommitment });
          if (!same(result.order.intentCommitment, order.intentCommitment) || result.order.status !== "cancelled") throw new Error("Cancellation confirmation mismatch");
          cycle.cancellations[key]!.phase = "confirmed";
          cycle.cancellations[key]!.txHash = result.order.cancellationTxHash;
        } catch (error) {
          cycle.cancellations[key]!.phase = "uncertain"; cycle.cancellations[key]!.error = safeError(error);
        }
        await this.save();
      }
      return this.pollCycle(cycle);
    });
  }

  /** Explicit post-close collateral recovery; polling never submits a claim. */
  async recoverCash(id: string): Promise<CycleState> {
    return this.exclusive(async () => {
      const cycle = this.cycle(id); await this.pollCycle(cycle);
      if (cycle.activeOrders.length || cycle.positions.some((position) => position.snapshot.status === "open")) throw new Error("Close positions and cancel active orders before recovering residual collateral");
      await this.readiness(); await this.recoverCancelledResiduals(cycle, true);
      return this.pollCycle(cycle);
    });
  }

  async prepareClose(id: string, commitment?: Hex): Promise<CycleState> {
    return this.exclusive(async () => {
      const cycle = this.cycle(id); await this.pollCycle(cycle);
      const position = this.selectPosition(cycle, commitment);
      const previous = position.closes.at(-1);
      if (previous && previous.phase !== "context-rejected") return clone(cycle);
      await this.readiness();
      const opening = position.opening;
      const secrets = reconstructOpening(opening);
      const { context } = await this.request<{ context: JsonObject }>(`/position-closes/context?ownerCommitment=${this.data.ownerCommitment}&positionCommitment=${opening.positionCommitment}`);
      if (context.market?.marketId !== cycle.spec.marketId || !same(context.membershipProof?.leaf, opening.positionCommitment) ||
        !same(context.membershipProof?.root, context.positionRoot)) throw new Error("Position close context binding mismatch");
      const markPrice = positive(context.market.markPrice, "close mark price");
      const currentFundingIndex = BigInt(context.market.fundingIndex);
      const fundingDelta = BigInt(opening.size) * (currentFundingIndex - BigInt(opening.fundingIndex)) / PRICE_SCALE;
      const fundingPayment = opening.side === "long" ? fundingDelta : -fundingDelta;
      const settlement = settleClose({ side: opening.side, closeSize: BigInt(opening.size), entryPrice: BigInt(opening.entryPrice),
        markPrice, margin: BigInt(opening.margin), fundingPayment, fee: 0n });
      const payout = BigInt(context.payoutAmount);
      if (payout < 0n || payout > settlement.newMargin) throw new Error("Paired payout is outside actual trader equity");
      const output = this.newNote(payout, { ownerDigest: secrets.ownerDigest });
      const closed = createCircuitPositionNote({ marketId: opening.marketId, side: opening.side, size: 0n,
        entryPrice: BigInt(opening.entryPrice), margin: 0n, fundingIndex: BigInt(opening.fundingIndex),
        owner: this.data.ownerCommitment, ownerDigest: secrets.ownerDigest, spendSecretDigest: secrets.spendSecretDigest,
        spendSecret: "", rho: random(), blinding: random() });
      const closeCommitment = digestToFieldHex(`observation-close:${opening.positionCommitment}:${random()}`);
      const witness = clone({ ...secrets, marketId: opening.marketId, side: opening.side,
        positionCommitment: opening.positionCommitment, positionNullifier: opening.positionNullifier,
        closeCommitment, positionRoot: context.positionRoot, size: opening.size, closeSize: opening.size,
        entryPrice: opening.entryPrice, margin: opening.margin, fundingIndex: opening.fundingIndex,
        markPrice, currentFundingIndex, fundingPayment, fee: 0n, newMargin: payout,
        remainingMargin: 0n, marginOutputAmount: payout, newPositionCommitment: closed.commitment,
        newPositionRhoDigest: closed.rhoDigest, newPositionBlinding: closed.blinding,
        marginOutputCommitment: output.commitment, marginOutputAssetDigest: output.assetDigest,
        marginOutputBlinding: output.blinding, marginOutputRhoDigest: output.rhoDigest,
        marginOutputSpendSecretDigest: output.spendSecretDigest,
        pathIndices: context.membershipProof.indices, pathSiblings: context.membershipProof.siblings });
      position.closes.push({ closeCommitment, witness, output, phase: "ready", createdAt: this.now(),
        markPrice: markPrice.toString(), fundingIndex: currentFundingIndex.toString(), fundingPayment: fundingPayment.toString(),
        realizedPnl: settlement.realizedPnl.toString(), returnedMargin: payout.toString() });
      cycle.phase = "closing"; await this.save(); return clone(cycle);
    });
  }

  async close(id: string, commitment?: Hex): Promise<CycleState> {
    return this.exclusive(async () => {
      const cycle = this.cycle(id); await this.pollCycle(cycle);
      if (cycle.phase === "closed") return clone(cycle);
      const position = this.selectPosition(cycle, commitment);
      const attempt = position.closes.at(-1);
      if (!attempt) throw new Error("Prepare the close first");
      if (attempt.phase !== "ready") return clone(cycle); // Uncertainty is observation-only.
      await this.readiness();
      attempt.phase = "submitting"; attempt.submittedAt = this.now(); cycle.timings.closeSubmittedAt ??= this.now();
      await this.save();
      try {
        const { positionClose } = await this.request<{ positionClose: JsonObject }>("/position-closes/manual", attempt.witness);
        if (!same(positionClose.positionCommitment, position.opening.positionCommitment) ||
          !same(positionClose.positionNullifier, position.opening.positionNullifier) ||
          !same(positionClose.closeCommitment, attempt.closeCommitment) ||
          !same(positionClose.marginOutputCommitment, attempt.output.commitment) || !positionClose.settlementTxHash) {
          throw new Error("Paired close response does not match the persisted output/transaction");
        }
        attempt.response = positionClose; attempt.settlementTxHash = positionClose.settlementTxHash;
        // Availability is established by portfolio lifecycle + encrypted close event + membership below.
        await this.save();
      } catch (error) {
        // These exact checks run before submission or after the server retires an unsigned attempt.
        // Preserve every opening: an archived proof can still become the winning close later.
        attempt.phase = isContextRejection(error) ? "context-rejected" : "uncertain";
        attempt.error = safeError(error); await this.save();
      }
      return this.pollCycle(cycle);
    });
  }

  private async pollCycle(cycle: CycleState): Promise<CycleState> {
    const { portfolio } = await this.request<{ portfolio: JsonObject }>(`/portfolio?ownerCommitment=${this.data.ownerCommitment}`);
    if (!same(portfolio.ownerCommitment, this.data.ownerCommitment)) throw new Error("Portfolio belongs to another owner");
    const orders = portfolio.orders as OwnerOrderSnapshot[];
    const lineage = new Set<string>([cycle.intentCommitment.toLowerCase()]);
    for (let pass = 0; pass < orders.length; pass++) for (const order of orders) {
      if (order.sourceIntentCommitment && lineage.has(order.sourceIntentCommitment.toLowerCase())) lineage.add(order.intentCommitment.toLowerCase());
    }
    cycle.orders = orders.filter((order) => lineage.has(order.intentCommitment.toLowerCase()));
    cycle.activeOrders = activeObservationOrders(cycle.orders);
    for (const order of cycle.orders.filter((order) => order.status === "cancelled")) {
      const cancellation = cycle.cancellations?.[order.intentCommitment.toLowerCase()];
      if (cancellation) { cancellation.phase = "confirmed"; cancellation.txHash ??= order.cancellationTxHash; }
    }
    for (const order of cycle.orders) {
      const prior = cycle.matching.filter((item) => same(item.intentCommitment, order.intentCommitment)).at(-1);
      if (!prior || JSON.stringify(prior.matching) !== JSON.stringify(order.matching)) {
        cycle.matching.push({ observedAt: this.now(), intentCommitment: order.intentCommitment, matching: clone(order.matching) });
      }
    }
    if (cycle.orders.length && ["submitting", "uncertain"].includes(cycle.phase)) { cycle.phase = "accepted"; cycle.timings.acceptedObservedAt ??= this.now(); }
    const snapshots = (portfolio.positions as OwnerPositionSnapshot[]).filter((position) => lineage.has(position.sourceIntentCommitment.toLowerCase()));
    const events = portfolio.accountEvents as AccountEventRecord[];
    for (const snapshot of snapshots) {
      let position = cycle.positions.find((item) => same(item.opening.positionCommitment, snapshot.positionCommitment));
      if (!position) {
        let opening: PositionOpening | undefined;
        for (const event of events) {
          if (!same(event.ownerCommitment, this.data.ownerCommitment)) continue;
          let payload: JsonObject;
          try { payload = this.decryptEvent(event.ciphertext); } catch { continue; }
          if (payload.kind !== "position-opening" || !same(payload.opening?.positionCommitment, snapshot.positionCommitment)) continue;
          assertPositionOpeningAccountEvent({ ...snapshot, ownerCommitment: this.data.ownerCommitment }, event);
          opening = payload.opening;
          if (!opening || opening.marketId !== cycle.spec.marketId || !lineage.has(opening.sourceIntentCommitment.toLowerCase()) ||
            !same(opening.ownerDigest, this.note(cycle.noteCommitment).ownerDigest) || opening.side !== cycle.spec.side) throw new Error("Recovered opening does not match the submitted trader intent");
          reconstructOpening(opening); break;
        }
        if (!opening) { cycle.error = "Position exists; encrypted opening recovery is pending"; continue; }
        position = { snapshot, opening, closes: [] }; cycle.positions.push(position);
      }
      position.snapshot = snapshot;
      if (!snapshot.settlementTxHash) throw new Error("Observed position is missing settlement transaction evidence");
      if (snapshot.status !== "open") await this.reconcileClosedPosition(position, events);
    }
    if (cycle.positions.length) {
      this.note(cycle.noteCommitment).status = "spent";
      cycle.timings.openedObservedAt ??= this.now();
      if (!["closing", "closed"].includes(cycle.phase)) cycle.phase = "open";
      if (cycle.activeOrders.length) cycle.error = "Residual/open order remains; do not begin another cycle";
    }
    await this.recoverCancelledResiduals(cycle, false);
    // A never-filled cancelled input becomes spendable only after a fresh pool
    // recovery-status confirms it. Its planned change note never existed.
    const fullyCancelled = !snapshots.length && !cycle.activeOrders.length && cycle.orders.length > 0 &&
      cycle.orders.every((order) => order.status === "cancelled");
    if (fullyCancelled) { cycle.phase = "cancelled"; if (cycle.changeCommitment) this.note(cycle.changeCommitment).status = "spent"; }
    await this.reconcileNotes();
    const residuals = cycle.orders.filter((order) => order.isResidual && order.status === "cancelled");
    const refundsReady = residuals.every((order) => {
      const refund = cycle.refunds?.[order.intentCommitment.toLowerCase()];
      return refund?.phase === "zero" || (refund?.phase === "confirmed" && refund.noteCommitment &&
        ["available", "spent"].includes(this.note(refund.noteCommitment).status));
    });
    const changeReady = !cycle.changeCommitment || ["available", "spent"].includes(this.note(cycle.changeCommitment).status);
    const originalReady = !fullyCancelled || this.note(cycle.noteCommitment).status === "available";
    const closeOutputsReady = cycle.positions.every((position) => position.confirmedClose &&
      (BigInt(position.confirmedClose.returnedMargin) === 0n || this.data.notes.some((note) =>
        same(note.commitment, position.confirmedClose!.marginOutputCommitment) && ["available", "spent"].includes(note.status))));
    cycle.cashReconciled = Boolean(!cycle.activeOrders.length && refundsReady && changeReady && originalReady &&
      (fullyCancelled || (snapshots.length === cycle.positions.length && cycle.positions.length > 0 && closeOutputsReady)));
    if (cycle.cashReconciled && cycle.positions.length && cycle.positions.every((position) => position.snapshot.status !== "open")) {
      cycle.phase = "closed"; cycle.timings.closedObservedAt ??= this.now(); delete cycle.error;
    }
    if (cycle.phase === "closed" && !cycle.cashReconciled) cycle.phase = "closing";
    // Keep the sole terminal no-fill status gated on actual custody recovery.
    if (fullyCancelled && !cycle.cashReconciled) { cycle.phase = "accepted"; cycle.error = "Cancellation confirmed; private collateral reconciliation pending"; }
    await this.save(); return clone(cycle);
  }

  private async recoverCancelledResiduals(cycle: CycleState, allowSubmission: boolean): Promise<void> {
    for (const order of cycle.orders.filter((order) => order.isResidual && order.status === "cancelled")) {
      cycle.refunds ??= {};
      const key = order.intentCommitment.toLowerCase();
      let refund = cycle.refunds[key];
      if (refund?.phase === "confirmed" || refund?.phase === "zero") continue;
      const details = await this.request<JsonObject>("/orders/residual-claim", { intentCommitment: order.intentCommitment });
      if (!same(details.tokenDigest, this.data.collateralDigest) || !/^\d+$/.test(String(details.amount))) throw new Error("Residual collateral details mismatch");
      if (details.claimedCommitment) {
        if (!refund?.noteCommitment || !same(refund.noteCommitment, details.claimedCommitment)) throw new Error("Residual was claimed to an unavailable private note");
        await this.membership(refund.noteCommitment);
        refund.phase = "confirmed"; delete refund.error; continue;
      }
      if (refund && ["submitting", "uncertain"].includes(refund.phase)) continue;
      if (BigInt(details.amount) === 0n) { cycle.refunds[key] = { phase: "zero", amount: "0" }; await this.save(); continue; }
      if (!allowSubmission) continue;
      await this.readiness();
      if (!refund) {
        const note = this.newNote(BigInt(details.amount)); this.data.notes.push(note);
        refund = cycle.refunds[key] = { phase: "preparing", amount: String(details.amount), noteCommitment: note.commitment };
        await this.save();
      }
      const note = this.note(refund.noteCommitment!); assertNote(note, this.data);
      if (refund.amount !== String(details.amount)) throw new Error("Residual amount changed before collateral recovery");
      if (refund.phase === "preparing") {
        refund.proof = await this.prove("/secure-deposit-note", { amount: note.amount, blinding: note.blinding,
          commitment: note.commitment, ownerDigest: note.ownerDigest, rhoDigest: note.rhoDigest,
          spendSecretDigest: note.spendSecretDigest, tokenDigest: note.assetDigest });
        if (!same(refund.proof.commitment, note.commitment) || refund.proof.amount !== note.amount || !same(refund.proof.tokenDigest, note.assetDigest)) throw new Error("Residual proof binding mismatch");
        refund.phase = "ready"; await this.save();
      }
      if (refund.phase === "ready") {
        refund.phase = "submitting"; await this.save();
        try {
          const result = await this.request<JsonObject>("/orders/claim-residual", { intentCommitment: order.intentCommitment, depositProof: refund.proof });
          if (!same(result.commitment, note.commitment) || String(result.amount) !== note.amount) throw new Error("Residual recovery confirmation mismatch");
          refund.txHash = result.claimTxHash; await this.membership(note.commitment); refund.phase = "confirmed";
        } catch (error) { refund.phase = "uncertain"; refund.error = safeError(error); }
        await this.save();
        return; // At most one residual claim submission per explicit recovery call.
      }
    }
  }

  private async reconcileClosedPosition(position: ObservedPosition, events: AccountEventRecord[]): Promise<void> {
    const snapshot = position.snapshot;
    if (!snapshot.lifecycleTxHash) throw new Error("Closed position is missing lifecycle transaction evidence");
    for (const event of events) {
      if (!same(event.ownerCommitment, this.data.ownerCommitment)) continue;
      let payload: JsonObject; try { payload = this.decryptEvent(event.ciphertext); } catch { continue; }
      const record = payload.positionClose;
      if (payload.kind !== "position-close" || !record || !same(record.positionCommitment, snapshot.positionCommitment)) continue;
      assertPositionCloseAccountEvent(record as any, this.data.ownerCommitment, event);
      if (!same(record.positionNullifier, position.opening.positionNullifier) || !same(record.closeCommitment, snapshot.closeCommitment) ||
        !same(record.marginOutputCommitment, snapshot.marginOutputCommitment) ||
        (record.settlementTxHash && !same(record.settlementTxHash, snapshot.lifecycleTxHash))) throw new Error("Recovered paired close receipt mismatch");
      const stored = position.closes.find((attempt) => same(attempt.output.commitment, record.marginOutputCommitment));
      const output = payload.closeOutputNote ? { ...payload.closeOutputNote, ownerCommitment: this.data.ownerCommitment,
        walletAddress: this.data.address, status: "pending" as NoteStatus } as PrivateNote : stored?.output;
      if (!output) throw new Error("Closed trader output opening is unavailable");
      assertNote(output, this.data);
      if (!same(output.commitment, record.marginOutputCommitment)) throw new Error("Recovered close output commitment mismatch");
      const accounting = confirmedCloseAccounting(position.opening, record, output.amount, stored);
      if (BigInt(output.amount) > 0n) {
        await this.membership(output.commitment);
        if (!this.data.notes.some((note) => same(note.commitment, output.commitment))) this.data.notes.push({ ...output, status: "pending" });
      }
      // The server encrypts this event before broadcasting the journaled pair, so
      // the final transaction hash comes from the confirmed lifecycle snapshot.
      position.confirmedClose = { ...record, ...accounting, settlementTxHash: snapshot.lifecycleTxHash };
      if (stored) { stored.phase = "confirmed"; stored.settlementTxHash = snapshot.lifecycleTxHash; stored.confirmedAt ??= this.now(); }
      return;
    }
    // A liquidation remains visible and stops completion until explicitly reconciled.
  }

  private async reconcileNotes(): Promise<void> {
    const notes = this.data.notes.filter((note) => note.status !== "spent");
    for (let offset = 0; offset < notes.length; offset += 16) {
      const batch = notes.slice(offset, offset + 16);
      const result = await this.request<{ notes: Array<{ commitment: Hex; known: boolean; spent: boolean; activeIntentCommitment?: Hex }> }>("/notes/recovery-status", {
        notes: batch.map((note) => ({ commitment: note.commitment, nullifier: note.noteNullifier })),
      });
      for (const status of result.notes) {
        const note = batch.find((item) => same(item.commitment, status.commitment));
        if (!note) throw new Error("Private note status response contains an unexpected note");
        if (status.spent) note.status = "spent";
        else if (status.known && status.activeIntentCommitment) { note.status = "locked"; note.lockedByIntentCommitment = status.activeIntentCommitment; }
        else if (status.known) {
          // The absence of an accepted intent does not release a possibly submitted input.
          const ambiguous = Object.values(this.data.cycles).some((cycle) => same(cycle.noteCommitment, note.commitment) &&
            ["preparing", "ready", "submitting", "uncertain", "accepted"].includes(cycle.phase));
          if (!ambiguous) { note.status = "available"; delete note.lockedByIntentCommitment; }
        }
      }
    }
  }

  private async reconcileDepositInternal(deposit: DepositState): Promise<DepositState> {
    if (deposit.phase === "confirmed") return clone(deposit);
    if (!["submitting", "uncertain"].includes(deposit.phase)) return clone(deposit);
    try {
      const { note } = await this.request<{ note: JsonObject }>("/notes/deposit-asset/recover-confirmed", { commitment: deposit.commitment });
      if (!same(note.commitment, deposit.commitment) || !same(note.confirmedRecovery?.txHash, deposit.txHash) ||
        !Number.isSafeInteger(note.confirmedRecovery?.ledger) || note.confirmedRecovery.ledger <= 0 ||
        !same(note.membershipProof?.leaf, deposit.commitment)) throw new Error("Confirmed deposit receipt binding mismatch");
      deposit.phase = "confirmed"; deposit.confirmedAt = this.now(); delete deposit.error;
      const stored = this.note(deposit.commitment); stored.depositTxHash = deposit.txHash;
      await this.reconcileNotes();
      if (stored.status !== "available") throw new Error("Confirmed deposit note is not independently spendable");
    } catch (error) { deposit.phase = "uncertain"; deposit.error = safeError(error); }
    await this.save(); return clone(deposit);
  }

  private async readiness(): Promise<void> {
    const health = await this.request<JsonObject>("/health");
    if (health.ok !== true || health.auth?.required !== true || health.custody?.required !== true ||
      health.custody?.readyForRealAssets !== true || health.intentRegistry?.onchainRequired !== true ||
      health.settlements?.onchainRequired !== true || health.stellar?.onchainRelayEnabled !== true ||
      health.privacy?.hostedPairedCloseWitnessRoutesEnabled !== true || health.batchExecutor?.enabled !== true ||
      health.matching?.readyForPrivateMatching !== true || health.matching?.proofEngine?.devMode !== false ||
      !health.runtime?.clientStorageScope || !health.custody?.collateralAsset?.tokenDigest ||
      health.stellar?.network !== "testnet" || health.stellar?.networkPassphrase !== OBSERVATION_NETWORK ||
      health.custody?.collateralAsset?.tokenContract !== OBSERVATION_USDC ||
      health.custody?.collateralAsset?.code !== "USDC" || health.custody?.collateralAsset?.issuer !== OBSERVATION_ISSUER) {
      throw new Error("Deployed API is not ready for real custody/private matching/paired close observation");
    }
    if (this.data.runtimeScope && this.data.runtimeScope !== health.runtime.clientStorageScope) throw new Error("Deployed private-note runtime changed; observation halted");
    if (this.data.networkPassphrase && this.data.networkPassphrase !== health.stellar.networkPassphrase) throw new Error("Deployed Stellar network changed; observation halted");
    if (this.session?.networkPassphrase !== health.stellar.networkPassphrase) throw new Error("Authentication and custody network do not match");
    if ((this.data.collateralToken && this.data.collateralToken !== health.custody.collateralAsset.tokenContract) ||
      (this.data.collateralDigest && !same(this.data.collateralDigest, health.custody.collateralAsset.tokenDigest))) throw new Error("Deployed collateral changed; observation halted");
    this.data.runtimeScope = health.runtime.clientStorageScope; this.data.networkPassphrase = health.stellar.networkPassphrase;
    this.data.collateralToken = health.custody.collateralAsset.tokenContract; this.data.collateralDigest = health.custody.collateralAsset.tokenDigest;
    await this.save();
  }

  private async ensureAccountKey(): Promise<void> {
    if (!this.data.accountKey) {
      const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
      this.data.accountKey = { privateKey: ecdh.getPrivateKey().toString("base64url"), publicKey: ecdh.getPublicKey().toString("base64url") };
      await this.save();
    }
    const { accountKey } = await this.request<{ accountKey: JsonObject | null }>(`/account-keys?ownerCommitment=${this.data.ownerCommitment}`);
    if (accountKey && accountKey.publicKey !== this.data.accountKey.publicKey) throw new Error("Trader has another account encryption key; do not overwrite it");
    if (!accountKey) await this.request("/account-keys", { algorithm: "ecdh-p256-aes-gcm", ownerCommitment: this.data.ownerCommitment, publicKey: this.data.accountKey.publicKey });
  }

  private decryptEvent(ciphertext: string): JsonObject {
    const prefix = "pnlx-account-event-v1:";
    if (!this.data.accountKey || !ciphertext.startsWith(prefix)) throw new Error("Account event key/envelope unavailable");
    const envelope = JSON.parse(Buffer.from(ciphertext.slice(prefix.length), "base64url").toString("utf8"));
    if (envelope.alg !== "ecdh-p256-aes-gcm" || envelope.v !== 1) throw new Error("Unsupported account event envelope");
    const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(Buffer.from(this.data.accountKey.privateKey, "base64url"));
    const shared = ecdh.computeSecret(Buffer.from(envelope.ephemeralPublicKey, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(shared).digest(), Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
  }

  private async membership(commitment: Hex): Promise<JsonObject> {
    const { note } = await this.request<{ note: JsonObject }>(`/notes/membership?commitment=${commitment}`);
    if (!same(note.commitment, commitment) || !same(note.membershipProof?.leaf, commitment) ||
      !same(note.membershipProof?.root, note.membershipRoot)) throw new Error("Margin membership does not match the saved note");
    return note.membershipProof;
  }
  private async prove(path: string, input: JsonObject): Promise<JsonObject> {
    const bundle = await this.request<JsonObject>(path, input, false, this.proverUrl);
    if (!bundle.record || !bundle.artifact || JSON.stringify(bundle.record.proof) !== JSON.stringify(bundle.artifact.proof)) throw new Error("Action proof bundle binding mismatch");
    await this.request("/proofs/artifacts", bundle.artifact);
    return bundle.record;
  }
  private newNote(amount: bigint, input?: Pick<PrivateNote, "ownerDigest"> & Partial<Pick<PrivateNote, "spendSecretDigest">>): PrivateNote {
    const note = createSecureMarginNote({ amount, assetId: "usdc", assetDigest: this.data.collateralDigest!,
      owner: this.data.address, ownerDigest: input?.ownerDigest, spendSecretDigest: input?.spendSecretDigest,
      spendSecret: random(), rho: random(), blinding: random() });
    return { ...note, amount: note.amount.toString(), ownerCommitment: this.data.ownerCommitment, walletAddress: this.data.address, status: "pending" };
  }
  private selectPosition(cycle: CycleState, commitment?: Hex): ObservedPosition {
    const position = cycle.positions.find((item) => item.snapshot.status === "open" && (!commitment || same(item.opening.positionCommitment, commitment)));
    if (!position) throw new Error("No recovered open position is available to close");
    return position;
  }
  private note(commitment: Hex): PrivateNote {
    const note = this.data.notes.find((item) => same(item.commitment, commitment));
    if (!note) throw new Error("Saved private note opening is missing"); return note;
  }
  private deposit(id: string): DepositState { const result = this.data.deposits[id]; if (!result) throw new Error("Unknown deposit id"); return result; }
  private cycle(id: string): CycleState { const result = this.data.cycles[id]; if (!result) throw new Error("Unknown cycle id"); return result; }
  private async save(): Promise<void> { await this.options.persist(clone(this.data)); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Concurrent observation operations are forbidden");
    this.busy = true; try { return await operation(); } finally { this.busy = false; }
  }
  private async request<T = JsonObject>(path: string, body?: unknown, authenticated = true, origin = this.apiUrl): Promise<T> {
    if (authenticated) await this.authenticate();
    const started = this.now(); let status: number | undefined;
    try {
      const response = await this.fetcher(`${origin}${path}`, { method: body === undefined ? "GET" : "POST",
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(authenticated ? { authorization: `Bearer ${this.session!.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(body === undefined ? 30_000 : (this.options.requestTimeoutMs ?? 30 * 60_000)),
        redirect: "error" });
      status = response.status;
      const value = await response.json() as JsonObject;
      if (!response.ok) throw new ProtocolApiError(path.split("?")[0]!, status, typeof value.error === "string" ? value.error.slice(0, 300) : "request failed");
      return value as T;
    } finally {
      this.data.requests.push({ at: started, path: `${origin === this.apiUrl ? "api" : "prover"}:${path.split("?")[0]}`, method: body === undefined ? "GET" : "POST", ms: this.now() - started, ...(status === undefined ? {} : { status }) });
      if (this.data.requests.length > 5_000) this.data.requests.splice(0, this.data.requests.length - 5_000);
    }
  }
}

/** Same fee-aware integer sizing used by the deployed web client's custody flow. */
export function observationOrderSize(margin: bigint, leverage: number, price: bigint): bigint {
  if (margin <= 32n || !Number.isInteger(leverage) || leverage <= 0 || price <= 0n) return 0n;
  const notional = (margin - 32n) * BigInt(leverage) * RATE_SCALE / (RATE_SCALE + BigInt(leverage) * TAKER_FEE_PPM);
  return notional * PRICE_SCALE / price;
}
/** Historical partially-filled parents are superseded by their residual order. */
export function activeObservationOrders(orders: OwnerOrderSnapshot[]): OwnerOrderSnapshot[] {
  const superseded = new Set(orders.filter((order) => order.isResidual && order.sourceIntentCommitment)
    .map((order) => order.sourceIntentCommitment!.toLowerCase()));
  return orders.filter((order) => ["open", "partially-filled"].includes(order.status) && !superseded.has(order.intentCommitment.toLowerCase()));
}
/** Derive accounting only from a confirmed paired receipt and its verified output.
 * Counterparty margin is private: the paired proof enforces its exact cap, while
 * these checks enforce all payout bounds derivable from the trader's opening.
 */
export function confirmedCloseAccounting(opening: PositionOpening, record: JsonObject, returnedAmount: string,
  saved?: CloseAttempt): ConfirmedCloseAccounting {
  if (record.proof?.circuitId !== "position-close-pair" || record.marketId !== opening.marketId ||
    !same(record.positionCommitment, opening.positionCommitment) || !same(record.positionNullifier, opening.positionNullifier)) {
    throw new Error("Confirmed close is not bound to this paired position");
  }
  const markPrice = positive(String(record.markPrice), "confirmed close price");
  if (!/^-?\d+$/.test(String(record.currentFundingIndex)) || !/^\d+$/.test(returnedAmount)) throw new Error("Invalid confirmed close accounting values");
  const side = opening.side === "long" ? 1n : -1n;
  const size = BigInt(opening.size), margin = BigInt(opening.margin);
  const grossPricePnl = size * (markPrice - BigInt(opening.entryPrice)) / PRICE_SCALE * side;
  const fundingPayment = size * (BigInt(record.currentFundingIndex) - BigInt(opening.fundingIndex)) / PRICE_SCALE * side;
  const equity = margin + grossPricePnl - fundingPayment;
  const returnedMargin = BigInt(returnedAmount);
  const maximum = equity < 0n ? 0n : equity;
  const minimum = maximum < margin ? maximum : margin; // Pair collateral is at least the trader's nonnegative margin.
  if (returnedMargin < minimum || returnedMargin > maximum) throw new Error("Confirmed paired payout is outside the trader equity/collateral bounds");
  if (saved && (!same(saved.closeCommitment, record.closeCommitment) || !same(saved.output.commitment, record.marginOutputCommitment) ||
    saved.output.amount !== returnedAmount || String(saved.witness.markPrice) !== String(record.markPrice) ||
    String(saved.witness.currentFundingIndex) !== String(record.currentFundingIndex) || String(saved.witness.fee) !== "0" ||
    String(saved.witness.fundingPayment) !== fundingPayment.toString() || String(saved.witness.marginOutputAmount) !== returnedAmount)) {
    throw new Error("Confirmed paired accounting differs from the persisted authorized close");
  }
  const knownEntryFee = opening.entryFee !== undefined;
  if (knownEntryFee && !/^-?\d+$/.test(opening.entryFee!)) throw new Error("Invalid encrypted opening fee");
  const entryFee = knownEntryFee ? BigInt(opening.entryFee!) : undefined;
  const allocated = entryFee === undefined ? undefined : margin + entryFee;
  if (allocated !== undefined && allocated <= 0n) throw new Error("Opening fee does not leave valid allocated collateral");
  return { ...(entryFee === undefined ? {} : { entryFee: entryFee.toString(), totalFees: entryFee.toString(),
      allocatedMargin: allocated!.toString(), netPnl: (returnedMargin - allocated!).toString() }),
    closeFee: "0", fundingPayment: fundingPayment.toString(), grossPricePnl: grossPricePnl.toString(), returnedMargin: returnedAmount,
    pairedPayoutAdjustment: (returnedMargin - equity).toString(), payoutCapped: equity > 0n && returnedMargin < equity,
    accountingComplete: knownEntryFee };
}
function reconstructOpening(opening: PositionOpening) {
  if (!opening.positionSeed || BigInt(opening.positionSeed) === 0n || !Number.isSafeInteger(opening.fillIndex) || opening.fillIndex < 0) throw new Error("Encrypted position spending data is missing");
  const secrets = positionSecrets(opening.positionSeed, opening.fillIndex);
  const position = createCircuitPositionNote({ ...opening, ...secrets, blindingDigest: secrets.blinding,
    entryPrice: BigInt(opening.entryPrice), margin: BigInt(opening.margin), fundingIndex: BigInt(opening.fundingIndex), size: BigInt(opening.size),
    owner: "", ownerDigest: opening.ownerDigest, rho: "", blinding: "", spendSecret: "" });
  if (!same(position.commitment, opening.positionCommitment) || !same(position.positionNullifier, opening.positionNullifier)) throw new Error("Encrypted position opening does not reconstruct the settled commitment");
  return { marketDigest: position.marketDigest, ownerDigest: position.ownerDigest, rhoDigest: position.rhoDigest,
    blinding: position.blinding, spendSecretDigest: position.spendSecretDigest };
}
function assertNote(note: PrivateNote, state: ProtocolState): void {
  if (note.walletAddress !== state.address || !same(note.ownerCommitment, state.ownerCommitment) || !same(note.assetDigest, state.collateralDigest) ||
    !same(note.ownerDigest, digestToFieldHex(`owner:${state.address}`))) throw new Error("Private note does not belong to this trader/runtime");
  const input = { ...note, amount: BigInt(note.amount) };
  if (!same(secureMarginCommitment(input), note.commitment) || !same(secureMarginNullifier(input), note.noteNullifier)) throw new Error("Private note integrity check failed");
}
function same(left: unknown, right: unknown): boolean { return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase(); }
function positive(value: string, label: string): bigint { if (!/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${label} must be a positive integer string`); return BigInt(value); }
function validateId(id: string): void { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid observation operation id"); }
function random(): string { return randomBytes(32).toString("hex"); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as T; }
function safeError(error: unknown): string { return error instanceof ProtocolApiError ? error.message : "Request/confirmation unavailable; reconcile the saved operation without resubmitting"; }
function isContextRejection(error: unknown): boolean {
  return error instanceof ProtocolApiError && error.status === 500 && [
    "position close mark price mismatch; refresh the close context", "position close mark price mismatch",
    "position root is not current", "position close funding index mismatch",
  ].includes(error.detail);
}
