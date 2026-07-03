import { commitIntent, intentBindingFields } from "@pnlx/crypto";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { IntentRecord, IntentValidityRecord } from "@pnlx/protocol-types";
import type { ServerEnv } from "@/config/env";
import { assertAuthenticatedAccount } from "@/shared/http/auth-context";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import type {
  CreateIntentInput,
  ProveAndSubmitIntentInput,
  ProveAndSubmitIntentResult,
} from "@/features/intents/intents.model";

export class IntentsService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain?: OnchainRelayService,
    private readonly env: Pick<ServerEnv, "intentRegistryOnchainRequired"> = {
      intentRegistryOnchainRequired: false,
    },
  ) {}

  submit(input: CreateIntentInput, authenticated?: string): IntentRecord {
    this.validate(input, authenticated);
    return this.submitValidated(input);
  }

  proveAndSubmit(input: ProveAndSubmitIntentInput, authenticated?: string): ProveAndSubmitIntentResult {
    assertAuthenticatedAccount(authenticated, input.intent.owner, "owner");
    if (input.marginRoot !== this.executor.store.marginMembershipRoot()) {
      throw new Error("intent margin root is not current");
    }
    const validity = this.prover.proveIntentValidity(input);
    return {
      intent: this.submit({ intent: input.intent, validity }, authenticated),
      validity,
    };
  }

  validate(input: CreateIntentInput, authenticated?: string): void {
    const { intent, validity } = input;
    assertAuthenticatedAccount(authenticated, intent.owner, "owner");
    const expectedCommitment = commitIntent(intent);
    const binding = intentBindingFields(intent);
    if (validity.intentCommitment !== expectedCommitment) {
      throw new Error("intent proof commitment mismatch");
    }
    if (validity.noteNullifier !== intent.noteNullifier) {
      throw new Error("intent proof nullifier mismatch");
    }
    if (
      validity.batchDigest !== binding.batchDigest ||
      validity.marketDigest !== binding.marketDigest ||
      validity.ownerCommitmentField !== binding.ownerCommitmentField
    ) {
      throw new Error("intent proof public binding mismatch");
    }
    this.assertIntentValidityProof(validity);
  }

  submitValidated(input: CreateIntentInput): IntentRecord {
    const { intent, validity } = input;
    this.executor.store.recordProof(validity.proof);
    const prepared = this.executor.prepareIntent({ intent, validity });
    const relay = this.onchain?.submitIntent(prepared.record);
    this.assertSubmittedIntentRelay(relay, "submit");
    return this.executor.commitPreparedIntent(prepared);
  }

  assertSubmittedIntentRelay(
    result: OnchainRelayResult | undefined,
    functionName: "submit" | "cancel",
  ): void {
    if (!this.env.intentRegistryOnchainRequired) return;
    if (!this.onchain || !this.onchain.enabled) {
      throw new Error("intent registry requires on-chain relay");
    }
    assertSubmittedRelay(result, functionName);
  }

  private assertIntentValidityProof(validity: IntentValidityRecord): void {
    this.prover.assertBoundProof(
      validity.proof,
      "intent-validity",
      contractPublicInputHash([
        publicU128(validity.currentBatch),
        publicField(validity.batchDigest),
        publicField(validity.marketDigest),
        publicField(validity.ownerCommitmentField),
        publicField(validity.intentCommitment),
        publicField(validity.marginRoot),
        publicField(validity.noteCommitment),
        publicField(validity.noteNullifier),
        publicField(validity.noteChangeCommitment),
      ]),
    );
  }
}
