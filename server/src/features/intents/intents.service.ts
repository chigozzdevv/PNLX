import { commitIntent, intentBindingFields, circuitMatchingPayloadCommitment, ownerCommitment } from "@pnlx/crypto";
import { createDelegatedConditionalPolicy } from "@/shared/protocol/delegated-policies";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { Hex, IntentRecord, IntentValidityRecord } from "@pnlx/protocol-types";
import { assertIdenticalIntentSubmission, type PendingIntentSubmission } from "@/shared/protocol/intent-submission-journal";
import type { ProtocolStore } from "@/shared/state/store";
import type { ServerEnv } from "@/config/env";
import { assertAuthenticatedAccount } from "@/shared/http/auth-context";
import { StaleMarginRootError } from "@/shared/protocol/stale-margin-root.error";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelay, OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { ProverService } from "@/workers/prover/prover.service";
import type {
  CreateIntentInput,
  ProveAndSubmitIntentInput,
  ProveAndSubmitIntentResult,
} from "@/features/intents/intents.model";

const submissionLocks = new WeakMap<ProtocolStore, Map<Hex, Promise<unknown>>>();

export interface DurableIntentOptions {
  replacementOf?: Hex;
  beforeSubmit?: () => Promise<void>;
}

export class IntentsService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain?: OnchainRelay,
    private readonly env: Pick<ServerEnv, "intentRegistryOnchainRequired"> = {
      intentRegistryOnchainRequired: false,
    },
  ) {}

  submit(input: CreateIntentInput, authenticated?: string): IntentRecord {
    this.validate(input, authenticated);
    return this.submitValidated(input);
  }

  async submitDurable(input: CreateIntentInput, authenticated?: string, options: DurableIntentOptions = {}): Promise<IntentRecord> {
    this.validate(input, authenticated);
    return this.withSubmissionLock(input.validity.intentCommitment, async () => {
      const store = this.executor.store;
      const existing = store.pendingIntentSubmissions.get(input.validity.intentCommitment);
      let pending: PendingIntentSubmission;
      if (existing) {
        assertIdenticalIntentSubmission(existing, { ...existing, intent: input.intent, validity: input.validity,
          conditionalPolicy: input.conditionalPolicy, replacementOf: options.replacementOf });
        pending = existing;
      } else {
        const local = store.intents.get(input.validity.intentCommitment);
        if (local) {
          if (local.matchingPayloadCommitment !== input.validity.matchingPayloadCommitment ||
              local.noteNullifier !== input.validity.noteNullifier || local.marginRoot !== input.validity.marginRoot) {
            throw new Error("intent retry conflicts with accepted intent");
          }
          await this.persistConditionalPolicy(input);
          return local;
        }
        const historicalMarginRootVerified = await this.verifyOnchainMarginRoot(
          input.validity.marginRoot,
          input.validity.noteNullifier,
        );
        this.assertCurrentMarginRoot(input.validity.marginRoot, historicalMarginRootVerified);
        store.recordProof(input.validity.proof);
        pending = { intentCommitment: input.validity.intentCommitment, createdAt: Date.now(),
          intent: input.intent, validity: input.validity, prepared: this.executor.prepareIntent({
            intent: input.intent, validity: input.validity, historicalMarginRootVerified,
          }),
          conditionalPolicy: input.conditionalPolicy, replacementOf: options.replacementOf };
        store.addPendingIntentSubmission(pending);
        pending = store.pendingIntentSubmissions.get(pending.intentCommitment)!;
      }
      await this.persistConditionalPolicy(input);
      await this.flush();
      const registered = this.onchain?.enabled ? await this.registered(pending.intentCommitment) : false;
      if (!registered) await options.beforeSubmit?.();
      return this.finishPreparedSubmission(pending, registered);
    });
  }

  async recoverPendingIntents(): Promise<{ recovered: number; pending: number }> {
    let recovered = 0;
    for (const pending of [...this.executor.store.pendingIntentSubmissions.values()]) {
      await this.withSubmissionLock(pending.intentCommitment, async () => {
        if (!this.executor.store.pendingIntentSubmissions.has(pending.intentCommitment)) return;
        // Never submit an order merely because the process restarted.
        if (!this.onchain?.enabled || !await this.registered(pending.intentCommitment)) return;
        this.validate({ intent: pending.intent, validity: pending.validity });
        await this.finishPreparedSubmission(pending, true);
        recovered++;
      });
    }
    return { recovered, pending: this.executor.store.pendingIntentSubmissions.size };
  }

  async discardUnregisteredPendingIntent(
    intentCommitment: Hex,
    expectedCreatedAt: number,
    canDiscard: () => Promise<boolean>,
  ): Promise<boolean> {
    return this.withSubmissionLock(intentCommitment, async () => {
      const store = this.executor.store;
      const pending = store.pendingIntentSubmissions.get(intentCommitment);
      if (!pending || pending.createdAt !== expectedCreatedAt || !this.onchain?.enabled ||
          await this.registered(intentCommitment) || !await canDiscard() ||
          await this.registered(intentCommitment)) return false;
      if (store.pendingIntentSubmissions.get(intentCommitment) !== pending) return false;
      store.removePendingIntentSubmission(intentCommitment);
      await this.flush();
      return true;
    });
  }

  async confirmUnregisteredIntentAbsent(intentCommitment: Hex, canRelease: () => Promise<boolean>): Promise<boolean> {
    return this.withSubmissionLock(intentCommitment, async () => {
      const store = this.executor.store;
      if (!this.onchain?.enabled || store.pendingIntentSubmissions.has(intentCommitment) ||
          store.intents.has(intentCommitment) || await this.registered(intentCommitment) || !await canRelease()) return false;
      return !store.pendingIntentSubmissions.has(intentCommitment) && !store.intents.has(intentCommitment) &&
        !await this.registered(intentCommitment);
    });
  }

  private async finishPreparedSubmission(pending: PendingIntentSubmission, alreadyRegistered: boolean): Promise<IntentRecord> {
    let relay: OnchainRelayResult | undefined;
    if (!alreadyRegistered) {
      try {
        relay = this.onchain?.submitIntentAsync
          ? await this.onchain.submitIntentAsync(pending.prepared.record)
          : this.onchain?.submitIntent(pending.prepared.record);
        this.assertSubmittedIntentRelay(relay, "submit");
      } catch (error) {
        // A missing response is not a rejection. Keep the exact prepared opening until confirmed.
        let accepted = false;
        try { accepted = this.onchain?.enabled === true && await this.registered(pending.intentCommitment); } catch { /* retain original error */ }
        if (!accepted) throw error;
      }
    }
    const submissionTxHash = relay?.relays.find((item) => item.functionName === "submit" && item.submitted)?.txHash;
    let submissionSequence: bigint | undefined;
    if (this.onchain?.enabled) {
      if (!await this.registered(pending.intentCommitment)) throw new Error("intent registry acceptance is not confirmed");
      if (!this.onchain.intentMatchingPayloadCommitmentAsync || !this.onchain.isIntentActiveAsync) {
        throw new Error("exact intent registry recovery readers are required");
      }
      const payload = await this.onchain.intentMatchingPayloadCommitmentAsync(pending.intentCommitment);
      if (payload !== pending.prepared.record.matchingPayloadCommitment) throw new Error("registered intent matching payload mismatch");
      submissionSequence = this.onchain.intentSubmissionSequenceAsync
        ? await this.onchain.intentSubmissionSequenceAsync(pending.intentCommitment)
        : this.onchain.intentSubmissionSequence?.(pending.intentCommitment);
      if (submissionSequence === undefined || submissionSequence <= 0n) throw new Error("confirmed intent submission sequence is required");
      if (!this.executor.store.intents.has(pending.intentCommitment) && !await this.onchain.isIntentActiveAsync(pending.intentCommitment)) {
        throw new Error("accepted intent is inactive; settlement reconciliation is required");
      }
    } else if (this.env.intentRegistryOnchainRequired) {
      throw new Error("intent registry requires on-chain relay");
    }
    const record: IntentRecord = { ...pending.prepared.record, ...(submissionTxHash ? { submissionTxHash } : {}),
      ...(submissionSequence ? { submissionSequence } : {}) };
    this.executor.store.recordProof(pending.validity.proof);
    if (this.onchain?.enabled) this.executor.store.restoreConfirmedIntent(record, pending.prepared.privateMatchIntent);
    else if (!this.executor.store.intents.has(pending.intentCommitment)) this.executor.commitPreparedIntent({ ...pending.prepared, record });
    await this.flush();
    this.executor.store.removePendingIntentSubmission(pending.intentCommitment);
    await this.flush();
    return this.executor.store.intents.get(pending.intentCommitment)!;
  }

  private async registered(intentCommitment: Hex): Promise<boolean> {
    if (!this.onchain) return false;
    const result = this.onchain.isIntentRegisteredAsync
      ? await this.onchain.isIntentRegisteredAsync(intentCommitment)
      : this.onchain.isIntentRegistered?.(intentCommitment);
    if (typeof result !== "boolean") throw new Error("intent registration status is unavailable");
    return result;
  }

  private async flush(): Promise<void> {
    await (this.executor.store as { flush?: () => Promise<void> }).flush?.();
  }

  private async withSubmissionLock<T>(key: Hex, work: () => Promise<T>): Promise<T> {
    let locks = submissionLocks.get(this.executor.store);
    if (!locks) { locks = new Map(); submissionLocks.set(this.executor.store, locks); }
    const prior = locks.get(key) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(work);
    locks.set(key, run);
    try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
  }

  async persistConditionalPolicy(input:CreateIntentInput):Promise<void> {
    const policy = createDelegatedConditionalPolicy(input.conditionalPolicy, {
      intentCommitment: input.validity.intentCommitment,
      ownerCommitment: ownerCommitment(input.intent.owner), marketId: input.intent.marketId,
    });
    if (policy) this.executor.store.addDelegatedConditionalPolicy(policy);
    await (this.executor.store as { flush?: () => Promise<void> }).flush?.();
  }

  proveAndSubmit(input: ProveAndSubmitIntentInput, authenticated?: string): ProveAndSubmitIntentResult {
    assertAuthenticatedAccount(authenticated, input.intent.owner, "owner");
    this.syncSecureNotes();
    if (input.marginRoot !== this.executor.store.marginMembershipRoot()) {
      throw new StaleMarginRootError();
    }
    const validity = this.prover.proveIntentValidity(input);
    return {
      intent: this.submit({ intent: input.intent, validity }, authenticated),
      validity,
    };
  }

  async proveAndSubmitDurable(input: ProveAndSubmitIntentInput, authenticated?: string): Promise<ProveAndSubmitIntentResult> {
    assertAuthenticatedAccount(authenticated, input.intent.owner, "owner");
    this.syncSecureNotes();
    const historicalMarginRootVerified = await this.verifyOnchainMarginRoot(input.marginRoot, input.intent.noteNullifier);
    this.assertCurrentMarginRoot(input.marginRoot, historicalMarginRootVerified);
    const validity = this.prover.proveIntentValidityAsync
      ? await this.prover.proveIntentValidityAsync(input) : this.prover.proveIntentValidity(input);
    return { intent: await this.submitDurable({ intent: input.intent, validity }, authenticated), validity };
  }

  validate(input: CreateIntentInput, authenticated?: string): void {
    this.syncSecureNotes();
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
    const payload = circuitMatchingPayloadCommitment({
      intentCommitment: expectedCommitment, marketDigest: binding.marketDigest,
      ownerDigest: validity.ownerDigest, positionSeed: validity.positionSeed,
      signedSize: intent.side === "long" ? intent.size : -intent.size,
      limitPrice: intent.limitPrice, margin: intent.margin, noteNullifier: intent.noteNullifier,
      noteChangeCommitment: validity.noteChangeCommitment,
    });
    if (payload !== validity.matchingPayloadCommitment) throw new Error("intent matching payload proof mismatch");
    createDelegatedConditionalPolicy(input.conditionalPolicy, { intentCommitment: validity.intentCommitment,
      ownerCommitment: ownerCommitment(intent.owner), marketId: intent.marketId });
  }

  submitValidated(input: CreateIntentInput): IntentRecord {
    if (this.onchain?.enabled) throw new Error("on-chain intent submission requires the durable async path");
    const { intent, validity } = input;
    this.executor.store.recordProof(validity.proof);
    const prepared = this.executor.prepareIntent({ intent, validity });
    const policy = createDelegatedConditionalPolicy(input.conditionalPolicy, {
      intentCommitment: prepared.record.intentCommitment,
      ownerCommitment: ownerCommitment(intent.owner), marketId: intent.marketId,
    });
    if (policy) this.executor.store.addDelegatedConditionalPolicy(policy);
    const { alreadyRegistered, relay } = this.submitIntentOnchain(prepared.record);
    if (!alreadyRegistered) this.assertSubmittedIntentRelay(relay, "submit");
    const submissionTxHash = relay?.relays.find(
      (item) => item.functionName === "submit" && item.submitted,
    )?.txHash;
    const submissionSequence = this.onchain?.enabled
      ? this.onchain.intentSubmissionSequence?.(prepared.record.intentCommitment)
      : undefined;
    if (this.env.intentRegistryOnchainRequired && submissionSequence === undefined) {
      throw new Error("confirmed intent submission sequence is required");
    }
    return this.executor.commitPreparedIntent({
      ...prepared,
      record: {
        ...prepared.record,
        ...(submissionTxHash ? { submissionTxHash } : {}),
        ...(submissionSequence ? { submissionSequence } : {}),
      },
    });
  }

  private submitIntentOnchain(record: IntentRecord): {
    alreadyRegistered: boolean;
    relay?: OnchainRelayResult;
  } {
    try {
      return {
        alreadyRegistered: false,
        relay: this.onchain?.submitIntent(record),
      };
    } catch (error) {
      if (this.onchain?.isIntentRegistered?.(record.intentCommitment)) {
        return { alreadyRegistered: true };
      }
      throw error;
    }
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
        publicField(validity.assetDigest),
        publicU128(validity.currentBatch),
        publicField(validity.batchDigest),
        publicField(validity.marketDigest),
        publicField(validity.intentCommitment),
        publicField(validity.marginRoot),
        publicField(validity.noteNullifier),
        publicField(validity.noteChangeCommitment),
        publicField(validity.matchingPayloadCommitment),
      ]),
    );
  }

  private syncSecureNotes(): void {
    if (!this.onchain?.enabled || !this.env.intentRegistryOnchainRequired) return;
    if(!this.onchain.secureNoteSnapshot)throw new Error("secure note reader unavailable");
    const notes = this.onchain.secureNoteSnapshot([...this.executor.store.marginCommitments]);
    if (notes.root !== this.executor.store.marginMembershipRoot()) {
      this.executor.store.replaceMarginCommitments(notes.commitments);
    }
  }

  private async verifyOnchainMarginRoot(root: Hex, noteNullifier: Hex): Promise<boolean> {
    if (!this.env.intentRegistryOnchainRequired) return false;
    if (!this.onchain?.enabled || !this.onchain.isSecureNoteRootKnownAsync || !this.onchain.isSecureNullifierSpentAsync) {
      throw new Error("on-chain secure note recovery readers are required");
    }
    if (!await this.onchain.isSecureNoteRootKnownAsync(root)) throw new StaleMarginRootError();
    if (await this.onchain.isSecureNullifierSpentAsync(noteNullifier)) {
      throw new Error("intent note nullifier is already spent");
    }
    return true;
  }

  private assertCurrentMarginRoot(root: Hex, historicalMarginRootVerified: boolean): void {
    if (!historicalMarginRootVerified && root !== this.executor.store.marginMembershipRoot()) {
      throw new StaleMarginRootError();
    }
  }
}
