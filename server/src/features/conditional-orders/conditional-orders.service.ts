import { commitConditionalOrder } from "@pnlx/crypto";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { ServerEnv } from "@/config/env";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { PositionClosesService } from "@/features/position-closes/position-closes.service";
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
    const relay = this.onchain?.registerConditionalOrder(input);
    this.assertSubmittedConditionalRelay(relay, "register");
    this.executor.store.addConditionalOrder(input);
    return input;
  }

  trigger(input: CreateConditionalOrderInput): CreateConditionalOrderResult {
    const market = this.executor.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");
    if (input.markPrice !== this.currentMarkPrice(market.marketId, market.oraclePrice)) {
      throw new Error("conditional close mark price mismatch");
    }
    const closeCommitment = commitConditionalOrder(input);
    if (!this.executor.store.hasConditionalOrder(closeCommitment)) {
      throw new Error("conditional order not registered");
    }

    const record = this.prover.proveConditionalClose(input);
    const relay = this.onchain?.triggerConditionalClose(record);
    this.assertSubmittedConditionalRelay(relay, "trigger");
    const committed = withRelayEvidence(record, relay);
    this.executor.store.recordProof(committed.proof);
    this.executor.store.addConditionalClose(committed);
    return committed;
  }

  triggerProven(input: CreateProvenConditionalOrderInput): CreateConditionalOrderResult {
    const market = this.executor.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");
    if (input.markPrice !== this.currentMarkPrice(market.marketId, market.oraclePrice)) {
      throw new Error("conditional close mark price mismatch");
    }
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
    if (input.proof.circuitId !== "conditional-close") {
      throw new Error("conditional close proof circuit mismatch");
    }
    this.prover.assertBoundProof(
      input.proof,
      "conditional-close",
      contractPublicInputHash([
        publicU128(input.markPrice),
        publicField(input.positionNullifier),
        publicField(input.closeCommitment),
      ]),
    );

    const relay = this.onchain?.triggerConditionalClose(input);
    this.assertSubmittedConditionalRelay(relay, "trigger");
    const committed = withRelayEvidence(input, relay);
    this.executor.store.recordProof(committed.proof);
    this.executor.store.addConditionalClose(committed);
    return committed;
  }

  execute(input: ExecuteConditionalCloseInput): ExecuteConditionalCloseResult {
    const closeCommitment = commitConditionalOrder(input.trigger);
    assertTriggerMatchesClose(input.trigger, input.close, closeCommitment);

    const positionCloses = new PositionClosesService(this.executor, this.prover, this.onchain, this.env);
    const positionClose = positionCloses.prepare(input.close);
    const conditionalClose = this.trigger(input.trigger);
    return {
      conditionalClose,
      positionClose: positionCloses.commit(positionClose),
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
