import { commitIntent, intentBindingFields, ownerCommitment } from "@merkl/crypto";
import { batchSettlementPublicInputHash } from "@/shared/protocol/batch-settlement-proof";
import {
  assertPositionOpeningAccountEvent,
  assertResidualOrderAccountEvent,
  positionOpeningAccountEventDataCommitment,
  positionOpeningAccountEventId,
  residualOrderAccountEventDataCommitment,
  residualOrderAccountEventId,
} from "@/shared/protocol/account-event-binding";
import type {
  AccountEventRecord,
  BatchSettlement,
  Hex,
  IntentRecord,
  MarketConfig,
  PositionLifecycleRecord,
  ProofMeta,
  ResidualOrderRecord,
  TradeIntent,
} from "@merkl/protocol-types";
import type { ProofArtifact } from "@merkl/proof-system";
import { ProtocolStore } from "@/shared/state/store";
import { ThresholdShareCommittee } from "@/workers/threshold-shares/threshold-shares.service";
import { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";
import type {
  ExecutorConfig,
  ExternalBatchSettlementCommitOptions,
  ExternalBatchSettlementTranscript,
  MerklExecutor,
  PreparedIntentSubmission,
  SettleBatchInput,
  SubmitIntentInput,
  SubmitSharedIntentInput,
} from "@/workers/executor/executor.model";

export class ExecutorService implements MerklExecutor {
  readonly store: ProtocolStore;
  readonly committee: ThresholdShareCommittee;
  private readonly matchingBackend: NonNullable<ExecutorConfig["matchingBackend"]>;
  private readonly proofs = new ProofCoordinatorService();
  private readonly pendingPositionOpenings = new Map<Hex, PositionLifecycleRecord[]>();
  private readonly pendingResidualOrders = new Map<Hex, ResidualOrderRecord[]>();

  constructor(config: ExecutorConfig, store = new ProtocolStore()) {
    this.matchingBackend = config.matchingBackend ?? "threshold-recovery";
    if (config.privateMatchingRequired && this.matchingBackend === "threshold-recovery") {
      throw new Error("private matching requires MATCHING_BACKEND=external-blind");
    }
    this.store = store;
    this.committee = new ThresholdShareCommittee({
      nodeIds: config.thresholdShareNodes,
      shareStoreDir: config.thresholdShareStoreDir,
      threshold: config.threshold,
    });
  }

  artifactFor(proof: ProofMeta): ProofArtifact | undefined {
    return this.proofs.artifactFor(proof);
  }

  addMarket(market: MarketConfig): void {
    this.store.addMarket(market);
  }

  deposit(commitment: Hex): void {
    this.store.addMarginCommitment(commitment);
  }

  prepareIntent(input: SubmitIntentInput): PreparedIntentSubmission {
    const intentCommitment = commitIntent(input.intent);
    if (input.validity.intentCommitment !== intentCommitment) {
      throw new Error("intent proof commitment mismatch");
    }
    if (input.validity.noteNullifier !== input.intent.noteNullifier) {
      throw new Error("intent proof nullifier mismatch");
    }
    if (input.validity.proof.circuitId !== "intent-validity") {
      throw new Error("intent proof circuit mismatch");
    }
    const binding = intentBindingFields(input.intent);
    if (
      input.validity.batchDigest !== binding.batchDigest ||
      input.validity.marketDigest !== binding.marketDigest ||
      input.validity.ownerCommitmentField !== binding.ownerCommitmentField
    ) {
      throw new Error("intent proof public binding mismatch");
    }
    const shareSets = this.committee.shareIntent(input.intent, intentCommitment);
    const shareCommitment = this.committee.shareCommitment("intent-shares", intentCommitment, shareSets);
    const record = {
      batchDigest: binding.batchDigest,
      batchId: input.intent.batchId,
      marketDigest: binding.marketDigest,
      marketId: input.intent.marketId,
      marginRoot: input.validity.marginRoot,
      ownerCommitmentField: binding.ownerCommitmentField,
      ownerCommitment: ownerCommitment(input.intent.owner),
      intentCommitment,
      proof: input.validity.proof,
      shareCommitment,
      noteNullifier: input.intent.noteNullifier,
    };

    return { record, shareSets };
  }

  commitPreparedIntent(input: PreparedIntentSubmission): IntentRecord {
    this.store.addIntent(input.record);
    this.committee.distribute(input.shareSets);
    return input.record;
  }

  submitIntent(input: SubmitIntentInput): IntentRecord {
    return this.commitPreparedIntent(this.prepareIntent(input));
  }

  prepareSharedIntent(input: SubmitSharedIntentInput): PreparedIntentSubmission {
    this.committee.assertShareSets(input.record.intentCommitment, input.shareSets);
    const shareCommitment = this.committee.shareCommitment(
      "intent-shares",
      input.record.intentCommitment,
      input.shareSets,
    );
    if (input.record.shareCommitment !== shareCommitment) {
      throw new Error("intent share commitment mismatch");
    }

    return {
      record: input.record,
      shareSets: input.shareSets,
    };
  }

  commitPreparedSharedIntent(input: PreparedIntentSubmission): IntentRecord {
    this.store.addIntent(input.record);
    this.committee.distribute(input.shareSets);
    return input.record;
  }

  submitSharedIntent(input: SubmitSharedIntentInput): IntentRecord {
    return this.commitPreparedSharedIntent(this.prepareSharedIntent(input));
  }

  settleBatch(input: SettleBatchInput): BatchSettlement {
    return this.commitBatchSettlement(this.createBatchSettlement(input));
  }

  createBatchSettlement(input: SettleBatchInput): BatchSettlement {
    if (this.matchingBackend === "external-blind") {
      throw new Error("external blind matching requires an externally proven settlement transcript");
    }
    const market = this.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");

    const relevant = Array.from(this.store.intents.values()).filter(
      (intent) =>
        intent.marketId === input.marketId &&
        this.store.orderLifecycle.get(intent.intentCommitment)?.status === "open",
    );
    const residuals = activeResiduals(this.store, input.marketId, input.batchId);
    if (relevant.length === 0 && residuals.length === 0) {
      throw new Error("batch has no active intents");
    }

    const transcript = this.committee.createSettlementTranscript({
      batchId: input.batchId,
      market,
      oldRoot: this.store.positionMembershipRoot(),
      positionCommitments: [...this.store.positionCommitments],
      records: relevant,
      residuals,
    }, this.proofs);
    const settlement = transcript.settlement;
    this.pendingPositionOpenings.set(
      settlement.settlementDigest,
      transcript.positionOpenings,
    );
    this.pendingResidualOrders.set(
      settlement.settlementDigest,
      transcript.residualOrders,
    );
    return settlement;
  }

  commitExternalBatchSettlement(
    transcript: ExternalBatchSettlementTranscript,
    options: ExternalBatchSettlementCommitOptions = {},
  ): BatchSettlement {
    this.validateExternalBatchSettlement(transcript);
    if (options.proofVerified) {
      this.store.recordProof(transcript.settlement.proof);
    }
    if (!this.store.hasProof(transcript.settlement.proof)) {
      throw new Error("external settlement proof is not verified");
    }
    this.store.addSettlement(
      transcript.settlement,
      transcript.positionOpenings,
      transcript.residualOrders ?? [],
      transcript.accountEvents,
    );
    return transcript.settlement;
  }

  commitBatchSettlement(settlement: BatchSettlement): BatchSettlement {
    this.store.recordProof(settlement.proof);
    const openings = this.pendingPositionOpenings.get(settlement.settlementDigest) ?? [];
    const residuals = this.pendingResidualOrders.get(settlement.settlementDigest) ?? [];
    this.store.addSettlement(settlement, openings, residuals);
    this.pendingPositionOpenings.delete(settlement.settlementDigest);
    this.pendingResidualOrders.delete(settlement.settlementDigest);
    return settlement;
  }

  validateExternalBatchSettlement(transcript: ExternalBatchSettlementTranscript): void {
    const { settlement } = transcript;
    const market = this.store.markets.get(settlement.marketId);
    if (!market) throw new Error("unknown market");
    if (settlement.oldRoot !== this.store.positionMembershipRoot()) {
      throw new Error("external settlement old root mismatch");
    }
    const expectedNewRoot = this.store.positionMembershipRootWithMany(settlement.newCommitments);
    if (settlement.newRoot !== expectedNewRoot) {
      throw new Error("external settlement new root mismatch");
    }
    if (settlement.fillCount !== settlement.newCommitments.length) {
      throw new Error("external settlement fill count mismatch");
    }
    if (new Set(settlement.newCommitments).size !== settlement.newCommitments.length) {
      throw new Error("external settlement duplicate commitment");
    }
    if (settlement.proof.circuitId !== "batch-match") {
      throw new Error("external settlement proof circuit mismatch");
    }
    if (settlement.proof.publicInputHash !== batchSettlementPublicInputHash(settlement)) {
      throw new Error("external settlement proof public input mismatch");
    }

    const activeOrders = activeOrderRecords(this.store, settlement.marketId);
    const expectedSpentNullifiers = new Set<Hex>();
    const updatedIntents = new Set<Hex>();
    for (const update of settlement.orderUpdates) {
      if (updatedIntents.has(update.intentCommitment)) {
        throw new Error("external settlement duplicate order update");
      }
      updatedIntents.add(update.intentCommitment);
      const order = activeOrders.get(update.intentCommitment);
      if (!order) throw new Error("external settlement unknown active order");
      if (update.status !== "filled" && update.status !== "partially-filled") {
        throw new Error("external settlement invalid order status");
      }
      if (!settlement.spentNullifiers.includes(order.noteNullifier)) {
        throw new Error("external settlement spent nullifier mismatch");
      }
      expectedSpentNullifiers.add(order.noteNullifier);
    }
    if (settlement.spentNullifiers.length !== expectedSpentNullifiers.size) {
      throw new Error("external settlement spent nullifier mismatch");
    }
    for (const nullifier of settlement.spentNullifiers) {
      if (!expectedSpentNullifiers.has(nullifier)) {
        throw new Error("external settlement spent nullifier mismatch");
      }
    }

    const updateOwners = new Map(
      settlement.orderUpdates.map((update) => [
        update.intentCommitment,
        activeOrders.get(update.intentCommitment)?.ownerCommitment,
      ]),
    );
    const openedCommitments = new Set<Hex>();
    for (const opening of transcript.positionOpenings) {
      if (openedCommitments.has(opening.positionCommitment)) {
        throw new Error("external position opening duplicate commitment");
      }
      openedCommitments.add(opening.positionCommitment);
      if (!settlement.newCommitments.includes(opening.positionCommitment)) {
        throw new Error("external position opening commitment mismatch");
      }
      if (opening.settlementDigest !== settlement.settlementDigest) {
        throw new Error("external position opening settlement mismatch");
      }
      if (opening.batchId !== settlement.batchId || opening.marketId !== settlement.marketId) {
        throw new Error("external position opening batch mismatch");
      }
      const owner = updateOwners.get(opening.sourceIntentCommitment);
      if (!owner || owner !== opening.ownerCommitment) {
        throw new Error("external position opening owner mismatch");
      }
    }
    if (transcript.positionOpenings.length !== settlement.newCommitments.length) {
      throw new Error("external position opening count mismatch");
    }
    for (const commitment of settlement.newCommitments) {
      if (!openedCommitments.has(commitment)) {
        throw new Error("external position opening commitment mismatch");
      }
    }

    const residualOrders = transcript.residualOrders ?? [];
    const residualByCommitment = new Set<Hex>();
    const residualUpdates = new Map(
      settlement.orderUpdates
        .filter((update) => update.residualCommitment)
        .map((update) => [update.residualCommitment!, update]),
    );
    for (const residual of residualOrders) {
      if (residualByCommitment.has(residual.intentCommitment)) {
        throw new Error("external residual order duplicate commitment");
      }
      residualByCommitment.add(residual.intentCommitment);
      const update = residualUpdates.get(residual.intentCommitment);
      if (!update || update.status !== "partially-filled") {
        throw new Error("external residual order update mismatch");
      }
      if (residual.batchId !== settlement.batchId || residual.marketId !== settlement.marketId) {
        throw new Error("external residual order batch mismatch");
      }
      if (residual.sourceIntentCommitment !== update.intentCommitment) {
        throw new Error("external residual order source mismatch");
      }
      const owner = updateOwners.get(update.intentCommitment);
      if (!owner || owner !== residual.ownerCommitment) {
        throw new Error("external residual order owner mismatch");
      }
      if (settlement.spentNullifiers.includes(residual.noteNullifier)) {
        throw new Error("external residual order nullifier mismatch");
      }
    }
    if (residualOrders.length !== residualUpdates.size) {
      throw new Error("external residual order count mismatch");
    }

    this.validateExternalAccountEvents(
      settlement.settlementDigest,
      transcript.positionOpenings,
      residualOrders,
      transcript.accountEvents,
    );
  }

  private validateExternalAccountEvents(
    settlementDigest: Hex,
    openings: PositionLifecycleRecord[],
    residualOrders: ResidualOrderRecord[],
    events: AccountEventRecord[],
  ): void {
    const byId = new Map(events.map((event) => [event.eventId, event]));
    if (byId.size !== events.length) {
      throw new Error("external account event duplicate id");
    }

    const expectedIds = new Set<Hex>();
    for (const opening of openings) {
      const event = findPositionOpeningEvent(opening, byId);
      if (!event) throw new Error("external position account event is required");
      assertPositionOpeningAccountEvent(opening, event);
      expectedIds.add(event.eventId);
    }
    for (const residual of residualOrders) {
      const event = findResidualOrderEvent(residual, settlementDigest, byId);
      if (!event) throw new Error("external residual account event is required");
      assertResidualOrderAccountEvent(residual, settlementDigest, event);
      expectedIds.add(event.eventId);
    }

    if (events.length !== expectedIds.size) {
      throw new Error("external account event count mismatch");
    }
  }
}

function findPositionOpeningEvent(
  opening: PositionLifecycleRecord,
  events: Map<Hex, AccountEventRecord>,
): AccountEventRecord | undefined {
  for (const event of events.values()) {
    const dataCommitment = positionOpeningAccountEventDataCommitment(opening, event.ciphertext);
    const eventId = positionOpeningAccountEventId(opening, dataCommitment);
    if (event.eventId === eventId) return event;
  }
  return undefined;
}

function findResidualOrderEvent(
  residual: ResidualOrderRecord,
  settlementDigest: Hex,
  events: Map<Hex, AccountEventRecord>,
): AccountEventRecord | undefined {
  for (const event of events.values()) {
    const dataCommitment = residualOrderAccountEventDataCommitment(residual, settlementDigest, event.ciphertext);
    const eventId = residualOrderAccountEventId(residual, settlementDigest, dataCommitment);
    if (event.eventId === eventId) return event;
  }
  return undefined;
}

function activeOrderRecords(
  store: ProtocolStore,
  marketId: string,
): Map<Hex, Pick<IntentRecord | ResidualOrderRecord, "intentCommitment" | "noteNullifier" | "ownerCommitment">> {
  const orders = new Map<Hex, Pick<IntentRecord | ResidualOrderRecord, "intentCommitment" | "noteNullifier" | "ownerCommitment">>();
  for (const order of [...store.intents.values(), ...store.residualOrders.values()]) {
    if (
      order.marketId === marketId &&
      store.orderLifecycle.get(order.intentCommitment)?.status === "open"
    ) {
      orders.set(order.intentCommitment, order);
    }
  }
  return orders;
}

function activeResiduals(
  store: ProtocolStore,
  marketId: string,
  batchId: string,
): ResidualOrderRecord[] {
  return [...store.residualOrders.values()]
    .filter((order) =>
      order.marketId === marketId &&
      store.orderLifecycle.get(order.intentCommitment)?.status === "open",
    )
    .map((order) => ({ ...order, batchId }));
}
