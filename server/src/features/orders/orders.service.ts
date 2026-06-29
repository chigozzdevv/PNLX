import { ownerCommitment } from "@merkl/crypto";
import type { OrderLifecycleRecord } from "@merkl/protocol-types";
import type { ServerEnv } from "../../config/env";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type { OnchainRelayService } from "../../workers/onchain/onchain.service";
import type { ProverService } from "../../workers/prover/prover.service";
import { IntentsService } from "../intents/intents.service";
import type {
  CancelOrderInput,
  CancelOrderResult,
  ReplaceOrderInput,
  ReplaceOrderResult,
} from "./orders.model";

export class OrdersService {
  private readonly intents: IntentsService;

  constructor(
    private readonly executor: ExecutorService,
    prover: ProverService,
    private readonly onchain?: OnchainRelayService,
    private readonly env: Pick<ServerEnv, "intentRegistryOnchainRequired"> = {
      intentRegistryOnchainRequired: false,
    },
  ) {
    this.intents = new IntentsService(executor, prover, onchain, env);
  }

  cancel(input: CancelOrderInput, authenticated?: string): CancelOrderResult {
    const order = this.executor.store.assertOrderCancellable(input.intentCommitment);
    assertOrderOwner(order, authenticated);
    const relay = this.onchain?.cancelIntent(input.intentCommitment);
    this.intents.assertSubmittedIntentRelay(relay, "cancel");
    return {
      order: this.executor.store.cancelOrder(input.intentCommitment),
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
    const cancelledOrder = this.executor.store.cancelOrder(input.intentCommitment);
    const replacementIntent = this.intents.submitValidated(input.replacement);
    return { cancelledOrder, replacementIntent };
  }
}

function assertOrderOwner(order: OrderLifecycleRecord, authenticated?: string): void {
  if (!authenticated) return;
  if (ownerCommitment(authenticated).toLowerCase() !== order.ownerCommitment.toLowerCase()) {
    throw new Error("order does not match authenticated account");
  }
}
