import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createObservationPlan, DAY_MS, HOUR_MS, MINUTE_MS, OBSERVATION_MAX_CONCURRENT,
  observationCloseDueAt, type ObservationPlan, type ObservationPlanInput, type ObservationCyclePlan } from "./plan";
import { ObservationProtocol, OBSERVATION_API_URL, type CycleState, type ProtocolState } from "./protocol";
import { createWalletIdentity, fundWallet, walletIdentity, accountBalances, type WalletRecord } from "./wallets";
import { renderExecutionEmail, sendExecutionEmail, type ExecutionEmailData } from "./email";
import { ObservationStore } from "./store";
import { readExecutionRuns, type PublicRunTiming } from "./metrics";

export const NEW_OPEN_GAP_MS = 20 * MINUTE_MS;
export const MISSED_SLOT_MS = 2 * HOUR_MS;
export const STALL_MS = 30 * MINUTE_MS;
export const EMAIL_DEDUP_MS = DAY_MS;
const MAX_WALLETS = 6;
const CREDIT_RESERVE_WEI = 160_000_000_000_000n;
const GAS_RESERVE_WEI = 30_000_000_000_000n;
const REQUESTOR = "0x68f4482Fd6D407Aba396080BC8BCf1D3957d7483";
const PROOF_MARKET = "0xfd152dadc5183870710fe54f939eae3ab9f0fe82";
const ROOT = resolve(import.meta.dir, "../..");
const STATE_DIRECTORY = resolve(ROOT, ".pnlx/observation");

export interface RuntimeConfig { resendKey: string; from: string; to: string | string[]; stateKey: string; }
export interface ProofBudget { at: number; chainId: number; creditWei: string; gasWei: string; }
export interface HealthSample {
  at: number; apiOk: boolean; proverOk: boolean;
  markets: Array<{ marketId: string; maxLeverage: number }>;
  budget?: ProofBudget;
}
export interface CampaignCycle {
  plan: ObservationCyclePlan;
  /** Adapter identifiers intentionally exclude the colon separators in plan IDs. */
  adapterId: string;
  status: "planned" | "active" | "closed" | "cancelled" | "missed";
  walletSource?: string;
  startedAt?: number;
  lastProgressAt?: number;
  progressFingerprint?: string;
  stallAlertedAt?: number;
  failureAlertedAt?: number;
  error?: string;
  depositId: string;
  fundingChecked?: boolean;
  openings: Record<string, { at: number; source: "chain" | "observed" }>;
}
export interface OutboxEntry {
  key: string;
  data: ExecutionEmailData;
  from: string;
  to: string | string[];
  rendered: ReturnType<typeof renderExecutionEmail>;
  assetFingerprint?: string;
  createdAt: number;
  state: "queued" | "accepted" | "held";
  attempts: number;
  firstAttemptAt?: number;
  lastAttemptAt?: number;
  nextAttemptAt: number;
  acceptedAt?: number;
  providerId?: string;
  holdReason?: string;
}
export interface CampaignState {
  version: 1;
  plan: ObservationPlan;
  pilot: boolean;
  pilotOverride?: { cycleId: string; market: "XLM"; side: "long"; marginUsdc: 10; leverage: 1; holdDurationMs: number; reason: string };
  cycles: CampaignCycle[];
  wallets: WalletRecord[];
  outbox: OutboxEntry[];
  health: HealthSample[];
  bootCount: number;
  lastBootAt?: number;
  lastTickAt?: number;
  lastNewOpenAt?: number;
  completedAt?: number;
  pausedReason?: string;
  pauseTransitions: number;
}
type ProtocolClient = Pick<ObservationProtocol, "state" | "prepareDeposit" | "submitDeposit" | "reconcileDeposit" |
  "prepareOpen" | "open" | "pollOpen" | "pollClose" | "prepareClose" | "close" | "cancelOpen" | "recoverCash">;
export interface RunnerServices {
  now(): number;
  persist(state: CampaignState): Promise<void>;
  protocol(wallet: WalletRecord, persist: (state: ProtocolState) => Promise<void>): ProtocolClient;
  createWallet(source: string): WalletRecord;
  fund(wallet: WalletRecord, persist: () => Promise<void>): Promise<void>;
  health(): Promise<HealthSample>;
  sendEmail(entry: OutboxEntry): Promise<{ id: string }>;
  emailAssetFingerprint?(): string;
  chainTime(hash: string): Promise<number | undefined>;
  balances?(address: string): Promise<{ USDC: string; XLM: string }>;
  executionRuns?(runIds: string[]): Promise<PublicRunTiming[]>;
  from: string;
  to: string | string[];
}

export function createCampaign(input: ObservationPlanInput, pilot = false): CampaignState {
  const generated = createObservationPlan(input);
  const cycles = generated.cycles.map((cycle) => ({ ...cycle }));
  if (pilot) {
    const first = cycles[0]!;
    // The explicit pilot remains cycle one of this campaign. Swap configurations
    // within day one so the daily side/market/margin/leverage/hold counts survive.
    const exposure = cycles.find((cycle) => cycle.day === 1 && cycle.market === "XLM" && cycle.side === "long")!;
    [first.market, exposure.market] = [exposure.market, first.market];
    [first.side, exposure.side] = [exposure.side, first.side];
    const margin = cycles.find((cycle) => cycle.day === 1 && cycle.marginUsdc === 10)!;
    [first.marginUsdc, margin.marginUsdc] = [margin.marginUsdc, first.marginUsdc];
    const leverage = cycles.find((cycle) => cycle.day === 1 && cycle.leverage === 1)!;
    [first.leverage, leverage.leverage] = [leverage.leverage, first.leverage];
    const short = cycles.find((cycle) => cycle.day === 1 && cycle.holdClass === "short")!;
    [first.holdClass, short.holdClass] = [short.holdClass, first.holdClass];
    [first.holdDurationMs, short.holdDurationMs] = [short.holdDurationMs, first.holdDurationMs];
    first.holdDurationMs = 5 * MINUTE_MS; first.plannedOpenAt = generated.startAt;
  }
  const plan: ObservationPlan = { ...generated, cycles };
  return {
    version: 1, plan, pilot,
    ...(pilot ? { pilotOverride: { cycleId: plan.cycles[0]!.cycleId, market: "XLM" as const, side: "long" as const,
      marginUsdc: 10 as const, leverage: 1 as const, holdDurationMs: 5 * MINUTE_MS,
      reason: "Explicit five-minute 10 USDC 1x XLM pilot; within-day configuration swaps preserve the daily distribution." } } : {}),
    cycles: plan.cycles.map((cycle) => {
      const adapterId = `obs-${createHash("sha256").update(cycle.cycleId).digest("hex").slice(0, 40)}`;
      return { plan: cycle, adapterId, depositId: `${adapterId}-deposit`, status: "planned", openings: {} };
    }),
    wallets: [], outbox: [], health: [], bootCount: 0, pauseTransitions: 0,
  };
}

function terminal(cycle: CampaignCycle): boolean { return ["closed", "cancelled", "missed"].includes(cycle.status); }
function protocolState(wallet: WalletRecord): ProtocolState | undefined { return wallet.protocol as ProtocolState | undefined; }
function protocolCycle(state: CampaignState, cycle: CampaignCycle): CycleState | undefined {
  const wallet = state.wallets.find((entry) => entry.source === cycle.walletSource);
  return wallet && protocolState(wallet)?.cycles[cycle.adapterId];
}
function unknownCycle(cycle: CycleState): boolean {
  return ["submitting", "uncertain"].includes(cycle.phase) ||
    cycle.positions.some((position) => position.closes.some((attempt) => ["submitting", "uncertain"].includes(attempt.phase))) ||
    Object.values(cycle.cancellations ?? {}).some((attempt) => ["submitting", "uncertain"].includes(attempt.phase)) ||
    Object.values(cycle.refunds ?? {}).some((attempt) => ["submitting", "uncertain"].includes(attempt.phase));
}
function unresolved(state: CampaignState, retryingPreparation?: CampaignCycle): boolean {
  return state.cycles.some((entry) => {
    if (entry.status !== "active") return false;
    const value = protocolCycle(state, entry);
    return (entry !== retryingPreparation &&
      (value?.marginRootRetryPending || entry.stallAlertedAt !== undefined || entry.failureAlertedAt !== undefined)) ||
      Boolean(value && unknownCycle(value));
  }) ||
    state.wallets.some((wallet) => Object.values(protocolState(wallet)?.deposits ?? {}).some((deposit) =>
      ["submitting", "uncertain"].includes(deposit.phase)) || wallet.funding.some((action) => !action.confirmedAt));
}
function openingProgress(state: CampaignState, cycle: CampaignCycle): string {
  const wallet = state.wallets.find((entry) => entry.source === cycle.walletSource);
  const deposit = wallet && protocolState(wallet)?.deposits[cycle.depositId];
  const opening = protocolCycle(state, cycle);
  return JSON.stringify([cycle.fundingChecked, deposit && [deposit.phase, deposit.commitment, deposit.txHash],
    opening && [opening.phase, opening.intentCommitment]]);
}
function iso(value: number | undefined): string | undefined { return value === undefined ? undefined : new Date(value).toISOString(); }
function units(value: unknown, scale = 7): string | undefined {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return undefined;
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale).replace(/0+$/, "") || "0"}`;
}
function safeHash(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:0x)?[0-9a-f]{64}$/i.test(value) ? value.replace(/^0x/, "") : undefined;
}
function rawError(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }

export function publicStatus(state: CampaignState) {
  const counts = { planned: 0, active: 0, closed: 0, cancelled: 0, missed: 0 };
  for (const cycle of state.cycles) counts[cycle.status] += 1;
  return {
    runId: state.plan.runId, startAt: iso(state.plan.startAt), endsAt: iso(state.plan.endsAt),
    completedAt: iso(state.completedAt), pilot: state.pilot, bootCount: state.bootCount,
    pilotConfiguration: state.pilotOverride,
    lastBootAt: iso(state.lastBootAt), lastTickAt: iso(state.lastTickAt),
    counts, wallets: state.wallets.length, pausedReason: state.pausedReason,
    email: { queued: state.outbox.filter((entry) => entry.state === "queued").length,
      accepted: state.outbox.filter((entry) => entry.state === "accepted").length,
      held: state.outbox.filter((entry) => entry.state === "held").length },
    latestHealth: state.health.at(-1),
  };
}

export class ObservationRunner {
  private clients = new Map<string, ProtocolClient>();
  private flushing = false;
  private sampling = false;
  private ticking = false;
  constructor(readonly state: CampaignState, private readonly services: RunnerServices) {
    if (state.version !== 1 || state.cycles.length !== 140 || state.plan.cycles.length !== 140 ||
      new Set(state.cycles.map((cycle) => cycle.adapterId)).size !== 140) throw new Error("Invalid saved observation campaign");
  }
  private save(): Promise<void> { return this.services.persist(this.state); }
  private client(wallet: WalletRecord): ProtocolClient {
    let client = this.clients.get(wallet.source);
    if (!client) {
      client = this.services.protocol(wallet, async (snapshot) => { wallet.protocol = snapshot; await this.save(); });
      this.clients.set(wallet.source, client);
    }
    return client;
  }
  async boot(): Promise<void> {
    this.state.bootCount += 1;
    this.state.lastBootAt = this.services.now();
    await this.save();
    if (this.state.bootCount > 1) await this.enqueueEmail(`boot-${this.state.bootCount}`, {
      kind: "resumed", message: "Run resumed. Pending executions are being reconciled.",
    });
  }
  async enqueueEmail(key: string, data: Omit<ExecutionEmailData, "runId" | "timestamp"> & Partial<Pick<ExecutionEmailData, "runId" | "timestamp">>): Promise<void> {
    const fullKey = `pnlx/${this.state.plan.runId}/${key}`;
    if (this.state.outbox.some((entry) => entry.key === fullKey)) return;
    const createdAt = this.services.now();
    const snapshot: ExecutionEmailData = structuredClone({ ...data, runId: this.state.plan.runId,
      timestamp: data.timestamp ?? new Date(createdAt).toISOString() });
    this.state.outbox.push({ key: fullKey, data: snapshot, from: this.services.from, to: structuredClone(this.services.to),
      rendered: renderExecutionEmail(snapshot), assetFingerprint: this.services.emailAssetFingerprint?.(),
      createdAt, state: "queued", attempts: 0, nextAttemptAt: createdAt });
    await this.save();
  }
  /** Serialized in-process and by the service lock; accepted IDs are never resent. */
  async flushOutbox(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const entry = this.state.outbox.find((item) => item.state === "queued" && item.nextAttemptAt <= this.services.now());
      if (!entry) return;
      const now = this.services.now();
      if ((entry.firstAttemptAt !== undefined && now - entry.firstAttemptAt >= EMAIL_DEDUP_MS) ||
        JSON.stringify(entry.rendered) !== JSON.stringify(renderExecutionEmail(entry.data)) ||
        entry.assetFingerprint !== this.services.emailAssetFingerprint?.()) {
        entry.state = "held";
        entry.holdReason = "Delivery requires provider reconciliation; automatic resend is disabled.";
        await this.save(); return;
      }
      entry.firstAttemptAt ??= now; entry.lastAttemptAt = now; entry.attempts += 1;
      await this.save(); // A crash after provider acceptance still reuses the same key/body.
      let accepted: { id: string };
      try { accepted = await this.services.sendEmail(structuredClone(entry)); }
      catch {
        entry.nextAttemptAt = this.services.now() + Math.min(HOUR_MS, 30_000 * 2 ** Math.min(entry.attempts - 1, 7));
        await this.save(); return;
      }
      entry.providerId = accepted.id; entry.acceptedAt = this.services.now(); entry.state = "accepted";
      // Persistence failure must terminate the worker. Do not reclassify an accepted
      // email as rejected or allow a financial action after a failed checkpoint.
      await this.save();
    } finally { this.flushing = false; }
  }
  async sampleHealth(force = false): Promise<void> {
    if (this.sampling || (!force && this.state.health.at(-1) && this.services.now() - this.state.health.at(-1)!.at < MINUTE_MS)) return;
    this.sampling = true;
    try {
      let sample: HealthSample;
      try { sample = await this.services.health(); }
      catch { sample = { at: this.services.now(), apiOk: false, proverOk: false, markets: [] }; }
      this.state.health.push(sample);
      if (this.state.health.length > 10_200) this.state.health.splice(0, this.state.health.length - 10_200);
      await this.save();
    } finally { this.sampling = false; }
  }
  private async observe(cycle: CampaignCycle, value: CycleState): Promise<void> {
    const now = this.services.now();
    const fingerprint = JSON.stringify([value.phase, value.activeOrders?.map((order) => [order.intentCommitment, order.status, order.matching]),
      value.matching, value.positions.map((position) => [position.snapshot.positionCommitment, position.snapshot.status,
        position.closes.map((attempt) => attempt.phase), Boolean(position.confirmedClose)]), value.cashReconciled, value.refunds]);
    if (fingerprint !== cycle.progressFingerprint) {
      cycle.progressFingerprint = fingerprint; cycle.lastProgressAt = now;
      // A previous stall/failure remains visible in the outbox, while confirmed
      // progress can unblock the campaign after the adapter resolves uncertainty.
      if (!unknownCycle(value) && !["preparing", "ready"].includes(value.phase)) {
        delete cycle.stallAlertedAt; delete cycle.failureAlertedAt;
      }
      await this.save();
    }
    for (const position of value.positions) {
      const key = position.snapshot.positionCommitment;
      const tx = safeHash(position.snapshot.settlementTxHash);
      const settledAt = tx ? await this.services.chainTime(tx).catch(() => undefined) : undefined;
      if (!cycle.openings[key]) {
        // snapshot.openedAt is stamped before proof/settlement. It is therefore
        // unsuitable for a hold clock. A confirmed observation is conservative.
        cycle.openings[key] = settledAt !== undefined ? { at: settledAt, source: "chain" } :
          { at: value.timings.openedObservedAt ?? now, source: "observed" };
        await this.save();
      }
      const opening = cycle.openings[key]!;
      if (settledAt !== undefined && opening.source !== "chain") {
        opening.at = settledAt; opening.source = "chain"; await this.save();
      }
      const openingKey = `pnlx/${this.state.plan.runId}/${cycle.adapterId}/opened/${key}`;
      const closingKey = `pnlx/${this.state.plan.runId}/${cycle.adapterId}/closed/${key}`;
      if (this.state.outbox.some((entry) => entry.key === openingKey) &&
        (!position.confirmedClose || this.state.outbox.some((entry) => entry.key === closingKey))) continue;
      const balances = this.services.balances ? await this.services.balances(this.wallet(cycle).address).catch(() => undefined) : undefined;
      // Filled orders collapse to a generic "settled" matching summary without
      // a run ID. Recover candidate IDs from the entire recorded batch history.
      const runIds = [...new Set(value.matching.filter((entry) => entry.matching.batchId === position.snapshot.batchId)
        .map((entry) => entry.matching.runId).filter((id): id is `0x${string}` => Boolean(id)))];
      const runs = this.services.executionRuns && runIds.length ? await this.services.executionRuns(runIds).catch(() => []) : [];
      // Completion alone also describes failed retries. Only the settled run
      // bound to this confirmed position's settlement may supply its timings.
      const run = runs.find((entry) => entry.status === "settled" && entry.batchId === position.snapshot.batchId &&
        typeof entry.settlementDigest === "string" && entry.settlementDigest.toLowerCase() === position.snapshot.settlementDigest.toLowerCase() &&
        runIds.some((id) => id.toLowerCase() === entry.runId.toLowerCase()));
      const common = {
        cycleId: cycle.plan.cycleId, walletAlias: cycle.walletSource, market: cycle.plan.market, side: cycle.plan.side,
        margin: `${cycle.plan.marginUsdc} USDC`, leverage: value.spec.leverage,
        size: `${units(position.opening.size) ?? "unavailable"} ${cycle.plan.market}`,
        entryPrice: units(position.opening.entryPrice, 8) === undefined ? undefined : `$${units(position.opening.entryPrice, 8)}`,
        fees: units(position.opening.entryFee) === undefined ? undefined : `${units(position.opening.entryFee)} USDC`,
        plannedAt: iso(cycle.plan.plannedOpenAt), submittedAt: iso(value.timings.submissionStartedAt),
        matchedAt: iso(run?.phaseTimestamps?.proving), proofStartedAt: iso(run?.phaseTimestamps?.proving),
        proofCompletedAt: iso(run?.phaseTimestamps?.["batch-settlement"]),
        settledAt: iso(settledAt ?? opening.at),
        proofJobId: position.snapshot.boundlessRequestId,
        timings: {
          apiSubmissionMs: value.timings.acceptedAt && value.timings.submissionStartedAt ? value.timings.acceptedAt - value.timings.submissionStartedAt : undefined,
          openingObservedMs: value.timings.openedObservedAt && value.timings.submissionStartedAt ? value.timings.openedObservedAt - value.timings.submissionStartedAt : undefined,
        },
        balances: balances ? { ...balances, proofCreditETH: units(this.state.health.at(-1)?.budget?.creditWei, 18) } : undefined,
      };
      await this.enqueueEmail(`${cycle.adapterId}/opened/${key}`, {
        ...common, kind: "opened", timestamp: iso(opening.at), holdUntil: iso(observationCloseDueAt(cycle.plan, opening.at)),
        txHashes: tx ? [{ label: "Opening settlement", hash: tx }] : [],
        message: opening.source === "observed" ? "Opening time is the first confirmed observation; the source snapshot supplied no usable timestamp." : undefined,
      });
      if (position.confirmedClose) {
        const receipt = position.confirmedClose;
        const closeHash = safeHash(position.snapshot.lifecycleTxHash ?? receipt.settlementTxHash);
        const closeAt = closeHash ? await this.services.chainTime(closeHash).catch(() => undefined) : undefined;
        const observedClose = value.timings.closedObservedAt ?? now;
        const winningAttempt = position.closes.find((attempt) => attempt.closeCommitment.toLowerCase() === String(receipt.closeCommitment).toLowerCase());
        await this.enqueueEmail(`${cycle.adapterId}/closed/${key}`, {
          ...common, kind: "closed", timestamp: iso(closeAt ?? observedClose ?? now),
          plannedAt: undefined, submittedAt: iso(winningAttempt?.submittedAt), matchedAt: undefined,
          proofStartedAt: undefined, proofCompletedAt: undefined,
          timings: { closeSubmissionToSettlementMs: winningAttempt?.submittedAt && closeAt ? closeAt - winningAttempt.submittedAt : undefined },
          settledAt: iso(closeAt ?? observedClose ?? now), exitPrice: units(receipt.markPrice, 8) === undefined ? undefined : `$${units(receipt.markPrice, 8)}`,
          fees: receipt.entryFee !== undefined || receipt.closeFee !== undefined ?
            `Entry ${units(receipt.entryFee) ?? "unavailable"}; close ${units(receipt.closeFee) ?? "unavailable"} USDC` : undefined,
          funding: units(receipt.fundingPayment) === undefined ? undefined : `${units(receipt.fundingPayment)} USDC`,
          pnl: units(receipt.netPnl) === undefined ? undefined : `${units(receipt.netPnl)} USDC`,
          message: closeAt === undefined ? "Close time is the first confirmed observation; a chain confirmation timestamp was unavailable." : undefined,
          holdingDurationMs: Math.max(0, (closeAt ?? observedClose ?? now) - opening.at),
          txHashes: closeHash ? [{ label: "Close settlement", hash: closeHash }] : [],
        });
      }
    }
    if ((value.phase === "closed" || value.phase === "cancelled") && value.cashReconciled) {
      cycle.status = value.phase;
      await this.save();
      if (value.phase === "cancelled") await this.enqueueEmail(`${cycle.adapterId}/cancelled`, {
        kind: "failed", cycleId: cycle.plan.cycleId, market: cycle.plan.market,
        message: "The unfilled order was cancelled and its collateral reconciled. This cycle did not complete an open/close trade.",
      });
    }
    const holdingNormally = value.phase === "open" && !value.activeOrders?.length &&
      value.positions.some((position) => position.snapshot.status === "open" &&
        now < observationCloseDueAt(cycle.plan, cycle.openings[position.snapshot.positionCommitment]!.at));
    if (!holdingNormally && cycle.status === "active" && now - (cycle.lastProgressAt ?? cycle.startedAt ?? now) >= STALL_MS && !cycle.stallAlertedAt) {
      cycle.stallAlertedAt = now; await this.save();
      await this.enqueueEmail(`${cycle.adapterId}/stalled/${Math.floor(now / STALL_MS)}`, {
        kind: "paused", cycleId: cycle.plan.cycleId, market: cycle.plan.market,
        message: "Execution has shown no confirmed progress for 30 minutes. New opens are paused while existing positions and submissions are reconciled.",
      });
    }
  }
  private wallet(cycle: CampaignCycle): WalletRecord {
    const wallet = this.state.wallets.find((entry) => entry.source === cycle.walletSource);
    if (!wallet) throw new Error("Saved observation wallet is missing");
    return wallet;
  }
  private async failure(cycle: CampaignCycle, error: unknown): Promise<void> {
    cycle.error = rawError(error); // Encrypted state only; never email/log API details.
    if (cycle.failureAlertedAt === undefined) {
      cycle.failureAlertedAt = this.services.now(); await this.save();
      await this.enqueueEmail(`${cycle.adapterId}/failure/${cycle.failureAlertedAt}`, { kind: "failed",
        cycleId: cycle.plan.cycleId, market: cycle.plan.market,
        message: "An execution request needs reconciliation. New opens are paused; saved positions and transactions remain under observation.",
      });
    } else await this.save();
  }
  private async updatePause(reason: string | undefined): Promise<void> {
    if (this.state.pausedReason === reason) return;
    const previouslyPaused = Boolean(this.state.pausedReason);
    this.state.pausedReason = reason; this.state.pauseTransitions += 1; await this.save();
    if (reason || previouslyPaused) await this.enqueueEmail(`pause-transition-${this.state.pauseTransitions}`, {
      kind: reason ? "paused" : "resumed", message: reason ?? "Confirmed reconciliation and budget checks now allow scheduled opens again.",
    });
  }
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try { await this.tickInternal(); } finally { this.ticking = false; }
  }
  private async tickInternal(): Promise<void> {
    const now = this.services.now();
    this.state.lastTickAt = now; await this.save();
    const active = this.state.cycles.filter((cycle) => cycle.status === "active");
    // Observe due/closing work first, regardless of budget or new-open failures.
    active.sort((a, b) => this.closePriority(a, now) - this.closePriority(b, now));
    for (const cycle of active) {
      const saved = protocolCycle(this.state, cycle);
      try {
        const client = this.client(this.wallet(cycle));
        if (!saved) {
          const deposit = client.state.deposits[cycle.depositId];
          if (deposit && ["submitting", "uncertain"].includes(deposit.phase)) {
            const before = openingProgress(this.state, cycle);
            const reconciled = await client.reconcileDeposit(cycle.depositId);
            if (["confirmed", "preparing"].includes(reconciled.phase)) await this.observeOpeningProgress(cycle, before);
          }
          continue;
        }
        const observed = saved.phase === "closing" ? await client.pollClose(cycle.adapterId) : await client.pollOpen(cycle.adapterId);
        await this.observe(cycle, observed);
      } catch (error) { await this.failure(cycle, error); }
    }
    // At most one explicit financial operation per tick. Each adapter persists
    // its own preparation/submission phase before making a consequential request.
    for (const cycle of active.filter((entry) => entry.status === "active")) {
      const value = protocolCycle(this.state, cycle);
      if (!value) continue;
      const client = this.client(this.wallet(cycle));
      try {
        const due = value.positions.find((position) => position.snapshot.status === "open" &&
          cycle.openings[position.snapshot.positionCommitment] && now >= observationCloseDueAt(cycle.plan, cycle.openings[position.snapshot.positionCommitment]!.at));
        if (due) {
          // Retire any residual exposure before spending the confirmed position.
          if (value.activeOrders?.length) { await client.cancelOpen(cycle.adapterId); return; }
          const previous = due.closes.at(-1);
          if (!previous || previous.phase === "context-rejected") {
            // Close witnesses bind the current oracle/funding/root. Persist the
            // fresh preparation, then submit it immediately before that context
            // ages across scheduler ticks. Ambiguous attempts remain poll-only.
            const prepared = await client.prepareClose(cycle.adapterId, due.snapshot.positionCommitment);
            const fresh = prepared.positions.find((position) => position.snapshot.positionCommitment === due.snapshot.positionCommitment)?.closes.at(-1);
            if (fresh?.phase === "ready") await client.close(cycle.adapterId, due.snapshot.positionCommitment);
          } else if (previous.phase === "ready") await client.close(cycle.adapterId, due.snapshot.positionCommitment);
          else continue; // Only observe ambiguous submissions; never rebuild them.
          return;
        }
        if (value.activeOrders?.length && (value.positions.length > 0 || now - (cycle.startedAt ?? now) >= STALL_MS)) {
          await client.cancelOpen(cycle.adapterId); return;
        }
        if (["closed", "cancelled"].includes(value.phase) && !value.cashReconciled) {
          await client.recoverCash(cycle.adapterId); return;
        }
      } catch (error) { await this.failure(cycle, error); return; }
    }
    // Reconcile a saved funding envelope before considering any fresh funding.
    // fundWallet serializes exact signed-envelope replay against Horizon.
    const funding = active.find((cycle) => cycle.status === "active" && this.wallet(cycle).funding.some((action) => !action.confirmedAt));
    if (funding) {
      try {
        await this.services.fund(this.wallet(funding), () => this.save());
        funding.fundingChecked = true; delete funding.failureAlertedAt; await this.save();
      } catch (error) { await this.failure(funding, error); }
      return;
    }
    await this.sampleHealth();
    const latest = this.state.health.at(-1);
    const healthy = latest && now - latest.at < 2 * MINUTE_MS && latest.apiOk && latest.proverOk;
    const enoughBudget = latest?.budget && BigInt(latest.budget.creditWei) >= CREDIT_RESERVE_WEI && BigInt(latest.budget.gasWei) >= GAS_RESERVE_WEI;
    const uncertain = unresolved(this.state);
    await this.updatePause(uncertain ? "An existing execution is stalled or uncertain. Existing positions continue to be observed and closed." :
      !healthy ? "Readiness checks are unavailable. Existing positions retain priority." :
      !enoughBudget ? "Proof credit or requestor gas is below the reserved closing budget. New opens are paused." : undefined);
    for (const cycle of this.state.cycles.filter((entry) => entry.status === "planned")) {
      if (now >= this.state.plan.endsAt || now - cycle.plan.plannedOpenAt > MISSED_SLOT_MS) {
        cycle.status = "missed"; await this.save();
        await this.enqueueEmail(`${cycle.adapterId}/missed`, { kind: "failed", cycleId: cycle.plan.cycleId, market: cycle.plan.market,
          message: "The scheduled opening window elapsed without execution. This cycle is recorded as missed; no catch-up trade was submitted.",
        });
      }
    }
    if (now >= this.state.plan.endsAt) {
      for (const cycle of this.state.cycles.filter((entry) => entry.status === "active")) {
        const value = protocolCycle(this.state, cycle);
        const deposit = protocolState(this.wallet(cycle))?.deposits[cycle.depositId];
        if ((!value || ["preparing", "ready"].includes(value.phase)) &&
          (!deposit || !["submitting", "uncertain"].includes(deposit.phase))) {
          cycle.status = "missed"; await this.save();
          await this.enqueueEmail(`${cycle.adapterId}/cutoff`, { kind: "failed", cycleId: cycle.plan.cycleId,
            market: cycle.plan.market,
            message: "The campaign cutoff arrived before order submission. This cycle is missed; any confirmed private deposit and its recovery data remain retained in encrypted state.",
          });
        }
      }
    }
    // Retry only this saved preparation's historical alerts. Every ambiguous
    // submission and every other cycle's alerts still block opening work.
    const preparing = this.state.cycles.find((cycle) => cycle.status === "active" &&
      (!protocolCycle(this.state, cycle) || ["preparing", "ready"].includes(protocolCycle(this.state, cycle)!.phase)));
    const preparingProtocol = preparing && protocolCycle(this.state, preparing);
    if (preparing && healthy && enoughBudget && now < this.state.plan.endsAt &&
      (!preparingProtocol?.retryAfterAt || now >= preparingProtocol.retryAfterAt) && !unresolved(this.state, preparing)) {
      await this.advanceOpening(preparing, latest!); return;
    }
    if (!this.state.pausedReason && now < this.state.plan.endsAt) {
      const next = this.state.cycles.find((cycle) => cycle.status === "planned" && cycle.plan.plannedOpenAt <= now);
      if (next && this.state.cycles.filter((cycle) => cycle.status === "active").length < OBSERVATION_MAX_CONCURRENT &&
        (this.state.lastNewOpenAt === undefined || now - this.state.lastNewOpenAt >= NEW_OPEN_GAP_MS)) {
        const busy = new Set(this.state.cycles.filter((cycle) => cycle.status === "active").map((cycle) => cycle.walletSource));
        let wallet = this.state.wallets.find((entry) => !busy.has(entry.source));
        if (!wallet && this.state.wallets.length < MAX_WALLETS) {
          const scope = createHash("sha256").update(this.state.plan.runId).digest("hex").slice(0, 12);
          wallet = this.services.createWallet(`pnlx-observation-${scope}-${this.state.wallets.length + 1}`);
          this.state.wallets.push(wallet); await this.save();
        }
        if (wallet) {
          next.walletSource = wallet.source; next.status = "active"; next.startedAt = now; next.lastProgressAt = now;
          this.state.lastNewOpenAt = now;
          await this.save();
          // Persist the initial private protocol state before any adapter action.
          wallet.protocol = this.client(wallet).state; await this.save();
          await this.advanceOpening(next, latest!); return;
        }
      }
    }
    if (now >= this.state.plan.endsAt && this.state.cycles.every(terminal) && !this.state.completedAt) {
      this.state.completedAt = now; await this.save();
      const counts = publicStatus(this.state).counts;
      await this.enqueueEmail("completed", { kind: "completed",
        message: `Campaign drained. ${counts.closed} confirmed open/close cycles, ${counts.cancelled} cancelled, ${counts.missed} missed. No scheduled timestamp was counted as a completed trade.`,
      });
    }
  }
  private closePriority(cycle: CampaignCycle, now: number): number {
    const value = protocolCycle(this.state, cycle);
    if (value?.phase === "closing") return -2;
    if (value?.positions.some((position) => position.snapshot.status === "open" && cycle.openings[position.snapshot.positionCommitment] &&
      now >= observationCloseDueAt(cycle.plan, cycle.openings[position.snapshot.positionCommitment]!.at))) return -1;
    return cycle.plan.plannedOpenAt;
  }
  private async advanceOpening(cycle: CampaignCycle, health: HealthSample): Promise<void> {
    const before = openingProgress(this.state, cycle);
    try {
      await this.advanceOpeningPhase(cycle, health);
      await this.observeOpeningProgress(cycle, before);
    } catch (error) { await this.failure(cycle, error); }
  }
  private async observeOpeningProgress(cycle: CampaignCycle, before: string): Promise<void> {
    if (openingProgress(this.state, cycle) !== before && !unresolved(this.state, cycle)) {
      cycle.lastProgressAt = this.services.now();
      delete cycle.failureAlertedAt; delete cycle.stallAlertedAt;
      await this.save();
    }
  }
  private async advanceOpeningPhase(cycle: CampaignCycle, health: HealthSample): Promise<void> {
    const wallet = this.wallet(cycle); const client = this.client(wallet);
    const saved = client.state;
    const existing = saved.cycles[cycle.adapterId];
    if (existing?.phase === "ready") { await client.open(cycle.adapterId); return; }
    if (existing?.phase === "preparing") { await client.prepareOpen(existing.spec); return; }
    if (existing) return;
    const margin = BigInt(cycle.plan.marginUsdc) * 10_000_000n;
    const note = saved.notes.some((entry) => entry.status === "available" && entry.walletAddress === wallet.address &&
      entry.ownerCommitment === saved.ownerCommitment && entry.assetDigest === saved.collateralDigest && BigInt(entry.amount) >= margin);
    if (!note) {
      const deposit = saved.deposits[cycle.depositId];
      if (!deposit && !cycle.fundingChecked) {
        await this.services.fund(wallet, () => this.save());
        cycle.fundingChecked = true; await this.save(); return;
      }
      if (!deposit || deposit.phase === "preparing") {
        // The simulated envelope binds the current tree footprint. Submit its
        // durable preparation immediately rather than age it across ticks.
        const prepared = await client.prepareDeposit(cycle.depositId, "1000000000");
        if (prepared.phase === "ready") await client.submitDeposit(cycle.depositId);
        return;
      }
      if (deposit.phase === "ready") { await client.submitDeposit(cycle.depositId); return; }
      if (["submitting", "uncertain"].includes(deposit.phase)) { await client.reconcileDeposit(cycle.depositId); return; }
      throw new Error("Confirmed deposit does not expose one available note sufficient for the planned margin");
    }
    const market = health.markets.find((entry) => entry.marketId.split(/[-_/]/)[0]?.toUpperCase() === cycle.plan.market);
    if (!market) throw new Error("Planned market is unavailable in the deployed API");
    const leverage = [8, 5, 3, 2, 1].find((value) => value <= cycle.plan.leverage && value <= market.maxLeverage);
    if (!leverage) throw new Error("Market maximum leverage is unavailable");
    await client.prepareOpen({ id: cycle.adapterId, marketId: market.marketId, margin: margin.toString(), leverage, side: cycle.plan.side });
  }
}

async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error("Read-only observation request failed");
  return response.json();
}
export async function readProofBudget(now = Date.now(), rpcUrl = process.env.BOUNDLESS_RPC_URL ?? "https://mainnet.base.org"): Promise<ProofBudget> {
  async function rpc(method: string, params: unknown[]) {
    const value = await json(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (value.error || typeof value.result !== "string" || !/^0x[0-9a-f]+$/i.test(value.result)) throw new Error("Proof budget RPC returned no usable result");
    return value.result as string;
  }
  const chainId = Number(BigInt(await rpc("eth_chainId", [])));
  if (chainId !== 8453) throw new Error("Proof budget RPC must be Base mainnet");
  const [credit, gas] = await Promise.all([
    rpc("eth_call", [{ to: PROOF_MARKET, data: `0x70a08231${REQUESTOR.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]),
    rpc("eth_getBalance", [REQUESTOR, "latest"]),
  ]);
  return { at: now, chainId, creditWei: BigInt(credit).toString(), gasWei: BigInt(gas).toString() };
}
export async function readHealth(): Promise<HealthSample> {
  const at = Date.now();
  const results = await Promise.allSettled([
    json(`${OBSERVATION_API_URL}/health/live`), json("http://127.0.0.1:4101/health"),
    json(`${OBSERVATION_API_URL}/markets`), readProofBudget(at),
  ]);
  const [api, prover, markets, budget] = results;
  return { at, apiOk: api.status === "fulfilled" && api.value.ok === true,
    proverOk: prover.status === "fulfilled" && prover.value.ok === true,
    markets: markets.status === "fulfilled" && Array.isArray(markets.value.markets) ? markets.value.markets.map((entry: any) =>
      ({ marketId: String(entry.marketId), maxLeverage: Number(entry.maxLeverage) })).filter((entry: any) => Number.isFinite(entry.maxLeverage)) : [],
    ...(budget.status === "fulfilled" ? { budget: budget.value } : {}) };
}
function readRuntimeConfig(): RuntimeConfig {
  const filename = resolve(STATE_DIRECTORY, "runtime.json");
  if ((statSync(filename).mode & 0o077) !== 0) throw new Error("Observation runtime.json must be private (mode 0600)");
  const config = JSON.parse(readFileSync(filename, "utf8")) as RuntimeConfig;
  if (!/^[a-f0-9]{64}$/i.test(config.stateKey) || typeof config.resendKey !== "string" || !config.resendKey ||
    typeof config.from !== "string" || !config.from || !(typeof config.to === "string" || Array.isArray(config.to))) {
    throw new Error("Observation runtime configuration is invalid");
  }
  return config;
}
function productionServices(config: RuntimeConfig, store: ObservationStore<CampaignState>): RunnerServices {
  const chainTimes = new Map<string, number>();
  return { now: Date.now, persist: (state) => store.write(state), from: config.from, to: config.to,
    createWallet: createWalletIdentity, fund: (wallet, persist) => fundWallet(wallet, persist, 250),
    protocol: (wallet, persist) => new ObservationProtocol({ identity: walletIdentity(wallet), state: protocolState(wallet), persist,
      requestTimeoutMs: 30 * MINUTE_MS }),
    health: readHealth, balances: accountBalances, executionRuns: readExecutionRuns,
    emailAssetFingerprint: () => createHash("sha256").update(readFileSync(resolve(ROOT, "client/public/pnlx-logo.png"))).digest("hex"),
    sendEmail: (entry) => sendExecutionEmail({ apiKey: config.resendKey, from: entry.from, to: entry.to, data: entry.data, idempotencyKey: entry.key }),
    async chainTime(hash) {
      if (chainTimes.has(hash)) return chainTimes.get(hash);
      const tx = await json(`https://horizon-testnet.stellar.org/transactions/${hash}`);
      if (tx.successful !== true) return undefined;
      const at = Date.parse(tx.created_at);
      if (!Number.isFinite(at)) return undefined;
      chainTimes.set(hash, at); return at;
    },
  };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--preflight")) { console.log(JSON.stringify(await readHealth(), null, 2)); return; }
  const config = readRuntimeConfig();
  const store = new ObservationStore<CampaignState>(resolve(STATE_DIRECTORY, "state.enc"), Buffer.from(config.stateKey, "hex"));
  if (args.includes("--status")) { console.log(JSON.stringify(store.exists() ? publicStatus(store.read()) : { initialized: false }, null, 2)); return; }
  if (process.env.PNLX_OBSERVATION_LOCKED !== "1") {
    mkdirSync(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
    const child = spawnSync("flock", ["-n", resolve(STATE_DIRECTORY, "runner.lock"), process.execPath, import.meta.filename, ...args], {
      cwd: ROOT, env: { ...process.env, PNLX_OBSERVATION_LOCKED: "1" }, stdio: "inherit",
    });
    if (child.status !== 0) throw new Error("Observation worker could not finish while holding its exclusive lock");
    return;
  }
  const initialize = args.includes("--init") || args.includes("--pilot");
  if (initialize && store.exists()) throw new Error("Observation campaign is already initialized; its start and plan are immutable");
  if (!store.exists()) {
    if (!initialize) throw new Error("Initialize this one-time campaign before running it");
    const now = Date.now();
    const state = createCampaign({ runId: `observation-${new Date(now).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`,
      seed: randomBytes(16).toString("hex"), startAt: now }, args.includes("--pilot"));
    await store.write(state);
    if (args.includes("--init")) { console.log(JSON.stringify(publicStatus(state), null, 2)); return; }
  }
  const state = store.read();
  const runner = new ObservationRunner(state, productionServices(config, store));
  if (args.includes("--setup-email")) {
    await runner.enqueueEmail("setup-connection", { kind: "setup", message: "Email updates are connected for this saved seven-day campaign." });
    await runner.flushOutbox(); console.log(JSON.stringify(publicStatus(state), null, 2)); return;
  }
  await runner.boot();
  if (args.includes("--once") || args.includes("--pilot")) {
    await runner.tick(); await runner.flushOutbox(); console.log(JSON.stringify(publicStatus(state), null, 2)); return;
  }
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; }); process.on("SIGINT", () => { stopping = true; });
  const timer = setInterval(() => {
    // Independent notifications/readiness continue during long proof requests.
    // A failed financial checkpoint must stop even an in-flight request rather
    // than waiting for that request to return before exiting.
    void runner.sampleHealth().catch(() => process.exit(1));
    void runner.flushOutbox().catch(() => process.exit(1));
  }, MINUTE_MS);
  try {
    while (!stopping) {
      await runner.tick(); await runner.flushOutbox();
      if (state.completedAt && !state.outbox.some((entry) => entry.state === "queued")) break;
      await Bun.sleep(MINUTE_MS);
    }
  } finally { clearInterval(timer); }
}
if (import.meta.main) {
  main().catch(() => { console.error("Observation worker stopped; inspect the private persisted state and public --status output."); process.exitCode = 1; });
}
