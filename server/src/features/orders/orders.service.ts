import { ownerCommitment } from "@pnlx/crypto";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { OrderLifecycleRecord } from "@pnlx/protocol-types";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
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
    private readonly onchain?: OnchainRelayService,
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
    this.prover.assertBoundProof(depositProof.proof, "deposit-note", contractPublicInputHash([
      publicU128(depositProof.amount), publicField(details.tokenDigest), publicField(depositProof.commitment),
    ]));
    if (details.claimedCommitment) {
      if (details.claimedCommitment.toLowerCase() !== depositProof.commitment.toLowerCase()) {
        throw new Error("residual already claimed with another commitment");
      }
      if (!this.executor.store.marginCommitments.has(depositProof.commitment)) {
        if (!this.onchain) throw new Error("residual claim requires on-chain relay");
        assertSubmittedRelay(this.onchain.verifyProof(depositProof.proof), "verify_and_record");
        this.executor.deposit(depositProof.commitment);
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
    this.executor.deposit(depositProof.commitment);
    return {
      amount: details.amount,
      commitment: depositProof.commitment,
      claimTxHash: relayTxHash(relay, "claim_residual"),
    };
  }

  cancel(input: CancelOrderInput, authenticated?: string): CancelOrderResult {
    const order = this.executor.store.assertOrderCancellable(input.intentCommitment);
    assertOrderOwner(order, authenticated);
    const relay = this.onchain?.cancelIntent(input.intentCommitment);
    this.intents.assertSubmittedIntentRelay(relay, "cancel");
    return {
      order: this.executor.store.cancelOrder(input.intentCommitment, relayTxHash(relay, "cancel")),
    };
  }

  replace(input: ReplaceOrderInput, authenticated?: string): ReplaceOrderResult {
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
}

function relayTxHash(
  result: ReturnType<OnchainRelayService["cancelIntent"]> | undefined,
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
