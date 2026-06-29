import { commitIntent, digestToFieldHex, intentBindingFields, intentOwnerCommitmentField } from "@merkl/crypto";
import { contractPublicInputHash, publicField, publicU128 } from "@merkl/proof-system";
import type { IntentRecord, IntentValidityRecord } from "@merkl/protocol-types";
import { proofKey } from "../../shared/proofs/artifact-registry";
import type { ServerEnv } from "../../config/env";
import {
  assertAuthenticatedAccount,
  assertAuthenticatedOwnerCommitment,
} from "../../shared/http/auth-context";
import { assertSubmittedRelay } from "../../shared/protocol/onchain-submission";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type { OnchainRelayResult } from "../../workers/onchain/onchain.model";
import type { OnchainRelayService } from "../../workers/onchain/onchain.service";
import type { ProverService } from "../../workers/prover/prover.service";
import type {
  CreateIntentInput,
  CreateSharedIntentInput,
  ProveAndSubmitIntentInput,
  ProveAndSubmitIntentResult,
} from "./intents.model";

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

  submitShared(input: CreateSharedIntentInput, authenticated?: string): IntentRecord {
    this.validateShared(input, authenticated);
    this.executor.store.recordProof(input.validity.proof);
    const prepared = this.executor.prepareSharedIntent(input);
    const relay = this.onchain?.submitIntent(prepared.record);
    this.assertSubmittedIntentRelay(relay, "submit");
    return this.executor.commitPreparedSharedIntent(prepared);
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
    const knownValidity = this.prover.intentValidityFor(validity.proof);
    if (!knownValidity) throw new Error("intent proof is not registered with prover");
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
    if (knownValidity.intentCommitment !== validity.intentCommitment) {
      throw new Error("intent proof commitment mismatch");
    }
    if (knownValidity.marginRoot !== validity.marginRoot) {
      throw new Error("intent proof root mismatch");
    }
    if (knownValidity.noteCommitment !== validity.noteCommitment) {
      throw new Error("intent proof note commitment mismatch");
    }
    if (knownValidity.noteNullifier !== validity.noteNullifier) {
      throw new Error("intent proof nullifier mismatch");
    }
    if (
      knownValidity.batchDigest !== validity.batchDigest ||
      knownValidity.marketDigest !== validity.marketDigest ||
      knownValidity.ownerCommitmentField !== validity.ownerCommitmentField
    ) {
      throw new Error("intent proof public binding mismatch");
    }
    if (
      knownValidity.currentBatch !== validity.currentBatch ||
      knownValidity.expiryBatch !== validity.expiryBatch
    ) {
      throw new Error("intent proof batch window mismatch");
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

  private validateShared(input: CreateSharedIntentInput, authenticated?: string): void {
    const { record, validity } = input;
    assertAuthenticatedOwnerCommitment(authenticated, record.ownerCommitment, "ownerCommitment");
    if (record.proof.circuitId !== "intent-validity") {
      throw new Error("intent proof circuit mismatch");
    }
    if (proofKey(record.proof) !== proofKey(validity.proof)) {
      throw new Error("intent proof record mismatch");
    }
    if (
      record.intentCommitment !== validity.intentCommitment ||
      record.marginRoot !== validity.marginRoot ||
      record.noteNullifier !== validity.noteNullifier
    ) {
      throw new Error("intent proof record mismatch");
    }
    if (
      record.batchDigest !== validity.batchDigest ||
      record.marketDigest !== validity.marketDigest ||
      record.ownerCommitmentField !== validity.ownerCommitmentField
    ) {
      throw new Error("intent proof public binding mismatch");
    }
    if (record.batchDigest !== digestToFieldHex(`batch:${record.batchId}`)) {
      throw new Error("intent batch binding mismatch");
    }
    if (record.marketDigest !== digestToFieldHex(`market:${record.marketId}`)) {
      throw new Error("intent market binding mismatch");
    }
    if (record.ownerCommitmentField !== intentOwnerCommitmentField(record.ownerCommitment)) {
      throw new Error("intent owner binding mismatch");
    }
    if (validity.proof.circuitId !== "intent-validity") {
      throw new Error("intent proof circuit mismatch");
    }
    if (validity.marginRoot !== this.executor.store.marginMembershipRoot()) {
      throw new Error("intent margin root is not current");
    }
    if (validity.expiryBatch < validity.currentBatch) {
      throw new Error("intent expired");
    }
    this.assertIntentValidityProof(validity);
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
      ]),
    );
  }
}
