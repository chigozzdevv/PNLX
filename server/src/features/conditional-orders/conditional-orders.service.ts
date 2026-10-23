import { commitConditionalOrder, hashFields } from "@pnlx/crypto";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { ServerEnv } from "@/config/env";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";
const conditionalJobs = new WeakMap<object, Map<string, Promise<unknown>>>();
import type {
  CreateConditionalOrderInput,
  CreateConditionalOrderResult,
  CreateProvenConditionalOrderInput,
  ExecuteConditionalCloseInput,
  ExecuteConditionalCloseResult,
  RegisterConditionalOrderInput,
  RegisterConditionalOrderResult,
} from "@/features/conditional-orders/conditional-orders.model";

export class ConditionalOrdersService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly env: ServerEnv,
    private readonly onchain?: OnchainRelayService,
  ) {}

  register(input: RegisterConditionalOrderInput): RegisterConditionalOrderResult {
    const previous = this.executor.store.conditionalOrders.get(input.closeCommitment);
    if (previous) {
      if (previous.marketId !== input.marketId || previous.positionNullifier !== input.positionNullifier) {
        throw new Error("conditional order scope mismatch");
      }
      return previous;
    }
    const relay = this.onchain?.registerConditionalOrder(input);
    this.assertSubmittedConditionalRelay(relay, "register");
    this.executor.store.addConditionalOrder(input);
    return input;
  }

  async registerAsync(input: RegisterConditionalOrderInput): Promise<RegisterConditionalOrderResult> {
    input = { ...input };
    return withConditionalJob(this.executor.store, `register:${input.closeCommitment}`, async () => {
      const previous = this.executor.store.conditionalOrders.get(input.closeCommitment);
      if (previous) {
        if (previous.marketId !== input.marketId || previous.positionNullifier !== input.positionNullifier) {
          throw new Error("conditional order scope mismatch");
        }
        return previous;
      }
      if (this.onchain?.enabled && !this.onchain.registerConditionalOrderAsync) {
        throw new Error("asynchronous conditional registration is unavailable");
      }
      const relay = await this.onchain?.registerConditionalOrderAsync(input);
      this.assertSubmittedConditionalRelay(relay, "register");
      const latest = this.executor.store.conditionalOrders.get(input.closeCommitment);
      if (latest && (latest.marketId !== input.marketId || latest.positionNullifier !== input.positionNullifier)) {
        throw new Error("conditional order scope mismatch");
      }
      if (!latest) this.executor.store.addConditionalOrder(input);
      await this.flush();
      return latest ?? input;
    });
  }

  async triggerAsync(input: CreateConditionalOrderInput): Promise<CreateConditionalOrderResult> {
    input = { ...input };
    const closeCommitment = commitConditionalOrder(input);
    return withConditionalJob(this.executor.store, `trigger:${closeCommitment}`, async () => {
      const market = this.executor.store.markets.get(input.marketId);
      if (!market) throw new Error("unknown market");
      const registered = this.executor.store.conditionalOrders.get(closeCommitment);
      if (!registered) throw new Error("conditional order not registered");
      if (registered.marketId !== input.marketId || registered.positionNullifier !== input.positionNullifier) {
        throw new Error("conditional order mismatch");
      }
      const previous = this.savedTrigger({ ...input, closeCommitment });
      if (previous) return previous;
      if (this.onchain?.enabled && !this.onchain.marketPriceAsync) throw new Error("asynchronous market price is unavailable");
      const markPrice = this.onchain?.enabled ? await this.onchain.marketPriceAsync(input.marketId) : market.oraclePrice;
      if (input.markPrice !== markPrice) throw new Error("conditional close mark price mismatch");
      if (!this.prover.proveConditionalCloseAsync) throw new Error("asynchronous conditional prover is unavailable");
      const record = await this.prover.proveConditionalCloseAsync(input);
      const relay = await this.relayTriggerAsync(record);
      const committed = withRelayEvidence(record, relay);
      const latest = this.savedTrigger({ ...input, closeCommitment });
      if (latest) return latest;
      this.executor.store.recordProof(committed.proof);
      this.executor.store.addConditionalClose(committed);
      await this.flush();
      return committed;
    });
  }

  trigger(input: CreateConditionalOrderInput): CreateConditionalOrderResult {
    const market = this.executor.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");
    const closeCommitment = commitConditionalOrder(input);
    const registered = this.executor.store.conditionalOrders.get(closeCommitment);
    if (!registered) {
      throw new Error("conditional order not registered");
    }
    if (registered.marketId !== input.marketId || registered.positionNullifier !== input.positionNullifier) throw new Error("conditional order mismatch");
    const previous = this.savedTrigger({ ...input, closeCommitment });
    if (previous) return previous;
    if (input.markPrice !== this.currentMarkPrice(market.marketId, market.oraclePrice)) {
      throw new Error("conditional close mark price mismatch");
    }

    const record = this.prover.proveConditionalClose(input);
    const relay = this.relayTrigger(record);
    const committed = withRelayEvidence(record, relay);
    this.executor.store.recordProof(committed.proof);
    this.executor.store.addConditionalClose(committed);
    return committed;
  }

  triggerProven(input: CreateProvenConditionalOrderInput): CreateConditionalOrderResult {
    const market = this.executor.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");
    const registered = this.executor.store.conditionalOrders.get(input.closeCommitment);
    if (!registered) {
      throw new Error("conditional order not registered");
    }
    if (
      registered.marketId !== input.marketId ||
      registered.positionNullifier !== input.positionNullifier
    ) {
      throw new Error("conditional order mismatch");
    }
    const previous = this.savedTrigger(input);
    if (previous) return previous;
    if (input.markPrice !== this.currentMarkPrice(market.marketId, market.oraclePrice)) {
      throw new Error("conditional close mark price mismatch");
    }
    if (input.proof.circuitId !== "conditional-close") {
      throw new Error("conditional close proof circuit mismatch");
    }
    this.prover.assertBoundProof(
      input.proof,
      "conditional-close",
      contractPublicInputHash([
        publicField(hashFields("market-id", [input.marketId])),
        publicU128(input.markPrice),
        publicField(input.positionNullifier),
        publicField(input.closeCommitment),
      ]),
    );

    const relay = this.relayTrigger(input);
    const committed = withRelayEvidence(input, relay);
    this.executor.store.recordProof(committed.proof);
    this.executor.store.addConditionalClose(committed);
    return committed;
  }

  private savedTrigger(input: Pick<CreateProvenConditionalOrderInput, "closeCommitment" | "marketId" | "positionNullifier">) {
    const previous = this.executor.store.conditionalCloses.get(input.closeCommitment);
    if (previous && (previous.marketId !== input.marketId || previous.positionNullifier !== input.positionNullifier)) {
      throw new Error("conditional order mismatch");
    }
    return previous;
  }

  private relayTrigger(record: CreateConditionalOrderResult): OnchainRelayResult | undefined {
    try {
      const relay = this.onchain?.triggerConditionalClose(record);
      this.assertSubmittedConditionalRelay(relay, "trigger");
      return relay;
    } catch (error) {
      if (!this.onchain?.enabled) throw error;
      let confirmed = false;
      try {
        confirmed = this.onchain.isConditionalTriggered(record.marketId, record.positionNullifier, record.closeCommitment);
      } catch {
        throw error;
      }
      if (!confirmed) throw error;
      return undefined;
    }
  }

  private async relayTriggerAsync(record: CreateConditionalOrderResult): Promise<OnchainRelayResult | undefined> {
    if (this.onchain?.enabled && !this.onchain.triggerConditionalCloseAsync) {
      throw new Error("asynchronous conditional trigger is unavailable");
    }
    try {
      const relay = await this.onchain?.triggerConditionalCloseAsync(record);
      this.assertSubmittedConditionalRelay(relay, "trigger");
      return relay;
    } catch (error) {
      if (!this.onchain?.enabled || !this.onchain.isConditionalTriggeredAsync) throw error;
      let confirmed = false;
      try { confirmed = await this.onchain.isConditionalTriggeredAsync(record.marketId, record.positionNullifier, record.closeCommitment); }
      catch { throw error; }
      if (!confirmed) throw error;
      return undefined;
    }
  }

  private async flush(): Promise<void> {
    await (this.executor.store as { flush?: () => Promise<void> }).flush?.();
  }

  async execute(input: ExecuteConditionalCloseInput, authenticated?: string): Promise<ExecuteConditionalCloseResult> {
    const closeCommitment = commitConditionalOrder(input.trigger);
    assertTriggerMatchesClose(input.trigger, input.close, closeCommitment);

    const positionCloses = new PositionClosesService(this.executor, this.prover, this.onchain, this.env);
    positionCloses.assertCloseOwner(input.close, authenticated);
    const previous = this.executor.store.conditionalCloses.get(closeCommitment);
    if (previous && (previous.marketId !== input.close.marketId || previous.positionNullifier !== input.close.positionNullifier)) {
      throw new Error("conditional order mismatch");
    }
    const conditionalClose = previous ?? this.trigger(input.trigger);
    return {
      conditionalClose,
      positionClose: await positionCloses.createConditionalPaired(input.close,authenticated),
    };
  }

  private assertSubmittedConditionalRelay(
    result: OnchainRelayResult | undefined,
    functionName: string,
  ): void {
    if (!this.env.conditionalOrdersOnchainRequired) return;
    if (!this.onchain || !this.onchain.enabled) {
      throw new Error("conditional orders require on-chain relay");
    }
    assertSubmittedRelay(result, functionName);
  }

  private currentMarkPrice(marketId: string, fallback: bigint): bigint {
    return this.onchain?.enabled ? this.onchain.marketPrice(marketId) : fallback;
  }
}

async function withConditionalJob<T>(store: object, key: string, work: () => Promise<T>): Promise<T> {
  const jobs = conditionalJobs.get(store) ?? new Map<string, Promise<unknown>>();
  conditionalJobs.set(store, jobs);
  const previous = jobs.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(work);
  jobs.set(key, task);
  try { return await task; }
  finally { if (jobs.get(key) === task) jobs.delete(key); }
}

function withRelayEvidence(
  record: CreateConditionalOrderResult,
  result: OnchainRelayResult | undefined,
): CreateConditionalOrderResult {
  const proofVerificationTxHash = result?.relays.find(
    (relay) => relay.functionName === "verify_and_record" && relay.submitted,
  )?.txHash;
  const triggerTxHash = result?.relays.find(
    (relay) => relay.functionName === "trigger" && relay.submitted,
  )?.txHash;
  return {
    ...record,
    ...(proofVerificationTxHash ? { proofVerificationTxHash } : {}),
    ...(triggerTxHash ? { triggerTxHash } : {}),
  };
}

function assertTriggerMatchesClose(
  trigger: CreateConditionalOrderInput,
  close: ExecuteConditionalCloseInput["close"],
  closeCommitment: `0x${string}`,
): void {
  if (!trigger.reduceOnly) {
    throw new Error("conditional close must be reduce-only");
  }
  if (close.closeCommitment !== closeCommitment) {
    throw new Error("conditional close commitment mismatch");
  }
  if (trigger.marketId !== close.marketId) {
    throw new Error("conditional close market mismatch");
  }
  if (trigger.positionNullifier !== close.positionNullifier) {
    throw new Error("conditional close position mismatch");
  }
  if (trigger.side !== close.side) {
    throw new Error("conditional close side mismatch");
  }
  if (trigger.markPrice !== close.markPrice) {
    throw new Error("conditional close mark price mismatch");
  }
  if (trigger.size !== close.closeSize) {
    throw new Error("conditional close size mismatch");
  }
  if (close.closeSize <= 0n || close.closeSize > close.size) {
    throw new Error("invalid close size");
  }
}
