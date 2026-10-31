import { ownerCommitment } from "@pnlx/crypto";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { OrderLifecycleRecord } from "@pnlx/protocol-types";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelay, OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { ProverService } from "@/workers/prover/prover.service";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import { withPositionMutation } from "@/shared/protocol/position-mutation";
import { IntentsService } from "@/features/intents/intents.service";
import type {
  CancelOrderInput,
  CancelOrderResult,
  ClaimResidualInput,
  ClaimResidualResult,
  ResidualClaimDetails,
  ReplaceOrderInput,
  ReplaceOrderResult,
} from "@/features/orders/orders.model";

export class OrdersService {
  private readonly intents: IntentsService;

  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain?: OnchainRelay,
    private readonly env: Pick<ServerEnv, "intentRegistryOnchainRequired"> & Partial<Pick<ServerEnv, "collateralTokenDigest">> = {
      intentRegistryOnchainRequired: false,
    },
  ) {
    this.intents = new IntentsService(executor, prover, onchain, env);
  }

  residualClaim(input: CancelOrderInput, authenticated?: string): ResidualClaimDetails {
    if (!authenticated) throw new Error("account authentication is required");
    const order = this.executor.store.orderLifecycle.get(input.intentCommitment);
    if (!order || !this.executor.store.residualOrders.has(input.intentCommitment)) {
      throw new Error("residual order not found");
    }
    assertOrderOwner(order, authenticated);
    if (order.status !== "cancelled") throw new Error("cancel the residual order first");
    if (!this.onchain?.enabled) throw new Error("residual claim requires on-chain relay");
    if (!this.env.collateralTokenDigest) throw new Error("collateral token digest is not configured");
    return {
      amount: this.onchain.residualMargin(input.intentCommitment),
      claimedCommitment: this.onchain.claimedResidual(input.intentCommitment),
      tokenDigest: this.env.collateralTokenDigest as `0x${string}`,
    };
  }

  claimResidual(input: ClaimResidualInput, authenticated?: string): ClaimResidualResult {
    const details = this.residualClaim(input, authenticated);
    const { depositProof } = input;
    if (depositProof.amount <= 0n) {
      throw new Error("invalid residual claim note");
    }
    if (depositProof.tokenDigest.toLowerCase() !== details.tokenDigest.toLowerCase()) {
      throw new Error("residual claim asset mismatch");
    }
    this.prover.assertBoundProof(depositProof.proof, "secure-deposit-note", contractPublicInputHash([
      publicU128(depositProof.amount), publicField(details.tokenDigest), publicField(depositProof.commitment),
    ]));
    if (details.claimedCommitment) {
      if (details.claimedCommitment.toLowerCase() !== depositProof.commitment.toLowerCase()) {
        throw new Error("residual already claimed with another commitment");
      }
      this.syncSecureNotes();
      if (!this.executor.store.marginCommitments.has(depositProof.commitment)) {
        throw new Error("claimed note is not in the on-chain secure tree");
      }
      return { amount: depositProof.amount, commitment: depositProof.commitment };
    }
    if (details.amount <= 0n || depositProof.amount !== details.amount) {
      throw new Error("residual claim amount mismatch");
    }
    if (!this.onchain) throw new Error("residual claim requires on-chain relay");
    assertSubmittedRelay(this.onchain.verifyProof(depositProof.proof), "verify_and_record");
    const relay = this.onchain.claimResidual(input.intentCommitment, depositProof.commitment, depositProof.proof);
    assertSubmittedRelay(relay, "claim_residual");
    this.syncSecureNotes();
    if (!this.executor.store.marginCommitments.has(depositProof.commitment)) {
      throw new Error("residual claim was not recorded in the on-chain secure tree");
    }
    return {
      amount: details.amount,
      commitment: depositProof.commitment,
      claimTxHash: relayTxHash(relay, "claim_residual"),
    };
  }

  private syncSecureNotes(): void {
    if (!this.onchain?.enabled || !this.onchain.secureNoteSnapshot) throw new Error("secure note reader unavailable");
    const notes = this.onchain.secureNoteSnapshot([...this.executor.store.marginCommitments]);
    if (notes.root !== this.executor.store.marginMembershipRoot()) {
      this.executor.store.replaceMarginCommitments(notes.commitments);
    }
  }

  cancel(input: CancelOrderInput, authenticated?: string): CancelOrderResult {
    if (this.onchain?.enabled) throw new Error("on-chain order cancellation requires the durable async path");
    const order = this.executor.store.assertOrderCancellable(input.intentCommitment);
    assertOrderOwner(order, authenticated);
    const relay = this.onchain?.cancelIntent(input.intentCommitment);
    this.intents.assertSubmittedIntentRelay(relay, "cancel");
    return {
      order: this.executor.store.cancelOrder(input.intentCommitment, relayTxHash(relay, "cancel")),
    };
  }

  async cancelDurable(input: CancelOrderInput, authenticated?: string): Promise<CancelOrderResult> {
    const store = this.executor.store;
    return withPositionMutation(store, async () => {
      if (!this.onchain?.enabled) {
        this.intents.assertSubmittedIntentRelay(undefined, "cancel");
        const existing = store.orderLifecycle.get(input.intentCommitment);
        if (existing) assertOrderOwner(existing, authenticated);
        const result = existing?.status === "cancelled" ? { order: existing } : this.cancel(input, authenticated);
        await (store as { flush?: () => Promise<void> }).flush?.();
        return result;
      }
      const order = store.orderLifecycle.get(input.intentCommitment);
      if (!order) throw new Error("unknown order");
      assertOrderOwner(order, authenticated);
      if (order.status !== "cancelled") store.assertOrderCancellable(input.intentCommitment);
      const source = store.intents.get(input.intentCommitment) ?? store.residualOrders.get(input.intentCommitment);
      if (!source) throw new Error("cancelled source intent is unavailable");
      if (!this.onchain.cancelIntentAsync || !this.onchain.isIntentActiveAsync ||
          !this.onchain.isIntentCancelledAsync || !this.onchain.isSecureNullifierSpentAsync) {
        throw new Error("exact async cancellation recovery readers are required");
      }
      if (store.spentNullifiers.has(source.noteNullifier) ||
          await this.onchain.isSecureNullifierSpentAsync(source.noteNullifier) !== false) {
        throw new Error("cancellation source collateral was spent; settlement reconciliation is required");
      }
      const cancelledBefore = await this.onchain.isIntentCancelledAsync(input.intentCommitment);
      const activeBefore = await this.onchain.isIntentActiveAsync(input.intentCommitment);
      if (typeof cancelledBefore !== "boolean" || typeof activeBefore !== "boolean" ||
          cancelledBefore === activeBefore) throw new Error("intent cancellation status is inconsistent or unavailable");
      let relay: OnchainRelayResult | undefined;
      let cancellationError: unknown;
      if (!cancelledBefore) {
        try {
          relay = await this.onchain.cancelIntentAsync(input.intentCommitment);
          this.intents.assertSubmittedIntentRelay(relay, "cancel");
        } catch (error) { cancellationError = error; }
      }
      const cancelled = await this.onchain.isIntentCancelledAsync(input.intentCommitment);
      const active = await this.onchain.isIntentActiveAsync(input.intentCommitment);
      const spent = await this.onchain.isSecureNullifierSpentAsync(source.noteNullifier);
      if (cancelled !== true || active !== false || spent !== false || store.spentNullifiers.has(source.noteNullifier)) {
        throw cancellationError ?? new Error("order cancellation is unconfirmed or source collateral was spent");
      }
      const current = store.orderLifecycle.get(input.intentCommitment);
      if (!current) throw new Error("cancelled order is unavailable");
      const result = current.status === "cancelled" ? current : store.cancelOrder(
        input.intentCommitment, relayTxHash(relay, "cancel"),
      );
      await (store as { flush?: () => Promise<void> }).flush?.();
      return { order: result };
    });
  }

  replace(input: ReplaceOrderInput, authenticated?: string): ReplaceOrderResult {
    if (this.onchain?.enabled) throw new Error("on-chain order replacement requires the durable async path");
    const order = this.executor.store.assertOrderCancellable(input.intentCommitment);
    assertOrderOwner(order, authenticated);
    const replacementOwner = ownerCommitment(input.replacement.intent.owner);
    if (replacementOwner.toLowerCase() !== order.ownerCommitment.toLowerCase()) {
      throw new Error("replacement owner does not match cancelled order");
    }

    this.intents.validate(input.replacement, authenticated);
    const relay = this.onchain?.cancelIntent(input.intentCommitment);
    this.intents.assertSubmittedIntentRelay(relay, "cancel");
    const cancelledOrder = this.executor.store.cancelOrder(
      input.intentCommitment,
      relayTxHash(relay, "cancel"),
    );
    const replacementIntent = this.intents.submitValidated(input.replacement);
    return { cancelledOrder, replacementIntent };
  }

  async replaceDurable(input:ReplaceOrderInput,authenticated?:string):Promise<ReplaceOrderResult> {
    const store = this.executor.store;
    const order = store.orderLifecycle.get(input.intentCommitment);
    if (!order) throw new Error("unknown order");
    assertOrderOwner(order, authenticated);
    if (ownerCommitment(input.replacement.intent.owner).toLowerCase() !== order.ownerCommitment.toLowerCase()) {
      throw new Error("replacement owner does not match cancelled order");
    }
    const pending = store.pendingIntentSubmissions.get(input.replacement.validity.intentCommitment);
    if (order.status === "cancelled" && pending?.replacementOf !== input.intentCommitment &&
        !store.intents.has(input.replacement.validity.intentCommitment)) throw new Error("order already cancelled");
    if (order.status !== "cancelled") store.assertOrderCancellable(input.intentCommitment);
    const replacementIntent = await this.intents.submitDurable(input.replacement, authenticated, {
      replacementOf: input.intentCommitment,
      beforeSubmit: async () => {
        await this.cancelDurable({ intentCommitment: input.intentCommitment }, authenticated);
      },
    });
    const cancelledOrder = store.orderLifecycle.get(input.intentCommitment)!;
    if (cancelledOrder.status !== "cancelled") throw new Error("replacement source cancellation requires reconciliation");
    return { cancelledOrder, replacementIntent };
  }
}

function relayTxHash(
  result: OnchainRelayResult | undefined,
  functionName: string,
) {
  return result?.relays.find((relay) => relay.functionName === functionName && relay.submitted)?.txHash;
}

function assertOrderOwner(order: OrderLifecycleRecord, authenticated?: string): void {
  if (!authenticated) return;
  if (ownerCommitment(authenticated).toLowerCase() !== order.ownerCommitment.toLowerCase()) {
    throw new Error("order does not match authenticated account");
  }
}
