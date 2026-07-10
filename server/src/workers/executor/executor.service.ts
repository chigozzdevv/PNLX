import { commitIntent, intentBindingFields, ownerCommitment } from "@pnlx/crypto";
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
  PrivateMatchIntent,
  PositionLifecycleRecord,
  ProofMeta,
  ResidualOrderRecord,
  TradeIntent,
} from "@pnlx/protocol-types";
import type { ProofArtifact } from "@pnlx/proof-system";
import { hasInitialMargin, hasMaxLeverage, maintenanceMargin } from "@pnlx/market-math";
import { ProtocolStore } from "@/shared/state/store";
import { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import {
  assertPrivateMatchIntent,
  matchingPayloadCommitment,
  privateMatchIntentFromTradeIntent,
} from "@/workers/batch-matcher/private-intent";
import type {
  ExecutorConfig,
  ExternalBatchSettlementCommitOptions,
  ExternalBatchSettlementTranscript,
  PnlxExecutor,
  PreparedIntentSubmission,
  SettleBatchInput,
  SubmitIntentInput,
} from "@/workers/executor/executor.model";

const ZERO_HEX = "0x0" as Hex;

export class ExecutorService implements PnlxExecutor {
  readonly store: ProtocolStore;
  private readonly proofs = new ProofCoordinatorService();
  private readonly matcher = new BatchMatcherService();
  private readonly pendingPositionOpenings = new Map<Hex, PositionLifecycleRecord[]>();
  private readonly pendingResidualOrders = new Map<Hex, ResidualOrderRecord[]>();

  constructor(config: ExecutorConfig, store = new ProtocolStore()) {
    void config.privateMatchingRequired;
    this.store = store;
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
    if (input.validity.marginRoot !== this.store.marginMembershipRoot()) {
      throw new Error("intent margin root is not current");
    }
    const privateMatchIntent = privateMatchIntentFromTradeIntent({
      intent: input.intent,
      intentCommitment,
      noteChangeCommitment: input.validity.noteChangeCommitment,
      ownerCommitment: ownerCommitment(input.intent.owner),
    });
    this.assertIntentRisk(privateMatchIntent);
    const record = {
      batchDigest: binding.batchDigest,
      batchId: input.intent.batchId,
      marketDigest: binding.marketDigest,
      marketId: input.intent.marketId,
      marginRoot: input.validity.marginRoot,
      noteChangeCommitment: input.validity.noteChangeCommitment,
      ownerCommitmentField: binding.ownerCommitmentField,
      ownerCommitment: privateMatchIntent.ownerCommitment,
      intentCommitment,
      matchingPayloadCommitment: matchingPayloadCommitment(privateMatchIntent),
      proof: input.validity.proof,
      noteNullifier: input.intent.noteNullifier,
    };

    return { privateMatchIntent, record };
  }

  private assertIntentRisk(intent: PrivateMatchIntent): void {
    const market = this.store.markets.get(intent.marketId);
    if (!market) return;
    const size = intent.signedSize < 0n ? -intent.signedSize : intent.signedSize;
    if (size <= 0n) throw new Error("intent size cannot be zero");
    if (intent.limitPrice <= 0n) throw new Error("intent limit price must be positive");
    if (!hasInitialMargin(size, intent.limitPrice, intent.margin, market.initialMarginRate)) {
      throw new Error("intent exceeds available margin at selected leverage");
    }
    if (!hasMaxLeverage(size, intent.limitPrice, intent.margin, market.maxLeverage)) {
      throw new Error("intent exceeds market max leverage");
    }
    if (intent.margin <= maintenanceMargin(size, intent.limitPrice, market.maintenanceMarginRate)) {
      throw new Error("intent margin is below maintenance buffer");
    }
  }

  commitPreparedIntent(input: PreparedIntentSubmission): IntentRecord {
    this.store.addIntent(input.record, input.privateMatchIntent);
    return input.record;
  }

  submitIntent(input: SubmitIntentInput): IntentRecord {
    return this.commitPreparedIntent(this.prepareIntent(input));
  }

  settleBatch(input: SettleBatchInput): BatchSettlement {
    return this.commitBatchSettlement(this.createBatchSettlement(input));
  }

  createBatchSettlement(input: SettleBatchInput): BatchSettlement {
    const market = this.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");

    const relevant = Array.from(this.store.intents.values()).filter(
      (intent) =>
        intent.batchId === input.batchId &&
        intent.marketId === input.marketId &&
        this.store.orderLifecycle.get(intent.intentCommitment)?.status === "open",
    );
    const residuals = activeResiduals(this.store, input.marketId, input.batchId);
    if (relevant.length === 0 && residuals.length === 0) {
      throw new Error("batch has no active intents");
    }

    const privateIntents = privateMatchIntentsFor(this.store, input.batchId, relevant, residuals);
    const match = this.matcher.match({
      batchId: input.batchId,
      intents: privateIntents,
      market,
    });
    const settlement = this.proofs.createSettlement({
      batchId: input.batchId,
      intents: privateIntents,
      market,
      match,
    });
    const positionOpenings = createPositionOpenings(settlement, match.fills);
    const residualPrivateIntents = match.residuals;
    const residualOrders = createResidualOrderRecords(settlement, residualPrivateIntents);
    this.pendingPositionOpenings.set(
      settlement.settlementDigest,
      positionOpenings,
    );
    this.pendingResidualOrders.set(
      settlement.settlementDigest,
      residualOrders,
    );
    for (const privateIntent of residualPrivateIntents) {
      this.store.privateMatchIntents.set(privateIntent.intentCommitment, privateIntent);
    }
    return settlement;
  }

  async createBatchSettlementAsync(input: SettleBatchInput): Promise<BatchSettlement> {
    const market = this.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");

    const relevant = Array.from(this.store.intents.values()).filter(
      (intent) =>
        intent.batchId === input.batchId &&
        intent.marketId === input.marketId &&
        this.store.orderLifecycle.get(intent.intentCommitment)?.status === "open",
    );
    const residuals = activeResiduals(this.store, input.marketId, input.batchId);
    if (relevant.length === 0 && residuals.length === 0) {
      throw new Error("batch has no active intents");
    }

    const privateIntents = privateMatchIntentsFor(this.store, input.batchId, relevant, residuals);
    const match = this.matcher.match({
      batchId: input.batchId,
      intents: privateIntents,
      market,
    });
    const settlement = await this.proofs.createSettlementAsync({
      batchId: input.batchId,
      intents: privateIntents,
      market,
      match,
    });
    const positionOpenings = createPositionOpenings(settlement, match.fills);
    const residualPrivateIntents = match.residuals;
    const residualOrders = createResidualOrderRecords(settlement, residualPrivateIntents);
    this.pendingPositionOpenings.set(settlement.settlementDigest, positionOpenings);
    this.pendingResidualOrders.set(settlement.settlementDigest, residualOrders);
    for (const privateIntent of residualPrivateIntents) {
      this.store.privateMatchIntents.set(privateIntent.intentCommitment, privateIntent);
    }
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
      transcript.privateMatchIntents ?? [],
    );
    return transcript.settlement;
  }

  commitBatchSettlement(settlement: BatchSettlement): BatchSettlement {
    this.store.recordProof(settlement.proof);
    const openings = this.pendingPositionOpenings.get(settlement.settlementDigest) ?? [];
    const residuals = this.pendingResidualOrders.get(settlement.settlementDigest) ?? [];
    const privateResiduals = residuals
      .map((residual) => this.store.privateMatchIntents.get(residual.intentCommitment))
      .filter((payload): payload is NonNullable<typeof payload> => Boolean(payload));
    this.store.addSettlement(settlement, openings, residuals, [], privateResiduals);
    this.pendingPositionOpenings.delete(settlement.settlementDigest);
    this.pendingResidualOrders.delete(settlement.settlementDigest);
    return settlement;
  }

  validateExternalBatchSettlement(transcript: ExternalBatchSettlementTranscript): void {
    const { settlement } = transcript;
    const market = this.store.markets.get(settlement.marketId);
    if (!market) throw new Error("unknown market");
    if (settlement.fillCount !== settlement.newCommitments.length) {
      throw new Error("external settlement fill count mismatch");
    }
    if (new Set(settlement.newCommitments).size !== settlement.newCommitments.length) {
      throw new Error("external settlement duplicate commitment");
    }
    if (settlement.proof.circuitId !== "batch-match") {
      throw new Error("external settlement proof circuit mismatch");
    }
    if (settlement.proof.proofSystem !== "risc0-groth16") {
      throw new Error("external settlement proof system mismatch");
    }
    if (settlement.proof.publicInputHash !== batchSettlementPublicInputHash(settlement)) {
      throw new Error("external settlement proof public input mismatch");
    }
    if (
      !settlement.proof.imageId ||
      !settlement.proof.journalDigest ||
      !settlement.proof.sealDigest
    ) {
      throw new Error("external settlement RISC0 receipt metadata is required");
    }
    if (settlement.proof.journalDigest !== settlement.proof.publicInputHash) {
      throw new Error("external settlement RISC0 journal mismatch");
    }
    if (settlement.proof.sealDigest !== settlement.proof.proofDigest) {
      throw new Error("external settlement RISC0 seal mismatch");
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
      if (
        order.noteChangeCommitment &&
        order.noteChangeCommitment !== ZERO_HEX &&
        !settlement.marginChangeCommitments.includes(order.noteChangeCommitment)
      ) {
        throw new Error("external settlement missing margin note change");
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
    const privateResiduals = new Map(
      (transcript.privateMatchIntents ?? []).map((payload) => [payload.intentCommitment, payload]),
    );
    for (const residual of residualOrders) {
      const payload = privateResiduals.get(residual.intentCommitment);
      if (!payload) throw new Error("external residual private match payload is required");
      assertPrivateMatchIntent(residual, payload);
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
): Map<
  Hex,
  Pick<IntentRecord | ResidualOrderRecord, "intentCommitment" | "noteNullifier" | "ownerCommitment"> & {
    noteChangeCommitment?: Hex;
  }
> {
  const orders = new Map<
    Hex,
    Pick<IntentRecord | ResidualOrderRecord, "intentCommitment" | "noteNullifier" | "ownerCommitment"> & {
      noteChangeCommitment?: Hex;
    }
  >();
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

function privateMatchIntentsFor(
  store: ProtocolStore,
  batchId: string,
  records: IntentRecord[],
  residuals: ResidualOrderRecord[],
): PrivateMatchIntent[] {
  return [
    ...residuals.map((record) => privateMatchIntentFor(store, record, batchId)),
    ...records.map((record) => privateMatchIntentFor(store, record, batchId)),
  ];
}

function privateMatchIntentFor(
  store: ProtocolStore,
  record: IntentRecord | ResidualOrderRecord,
  batchId: string,
): PrivateMatchIntent {
  const payload = store.privateMatchIntents.get(record.intentCommitment);
  if (!payload) throw new Error("private match payload not found");
  assertPrivateMatchIntent(record, payload);
  return {
    ...payload,
    batchId,
  };
}

function createPositionOpenings(
  settlement: BatchSettlement,
  fills: Array<{
    intentCommitment: Hex;
    marketId: string;
    ownerCommitment: Hex;
    positionCommitment: Hex;
    positionNullifier: Hex;
  }>,
): PositionLifecycleRecord[] {
  const now = Date.now();
  return fills.map((fill) => ({
    batchId: settlement.batchId,
    marketId: fill.marketId,
    openedAt: now,
    ownerCommitment: fill.ownerCommitment,
    positionCommitment: fill.positionCommitment,
    positionNullifier: fill.positionNullifier,
    settlementDigest: settlement.settlementDigest,
    sourceIntentCommitment: fill.intentCommitment,
    status: "open",
    updatedAt: now,
  }));
}

function createResidualOrderRecords(
  settlement: BatchSettlement,
  residuals: PrivateMatchIntent[],
): ResidualOrderRecord[] {
  const now = Date.now();
  return residuals.map((residual) => ({
    batchId: settlement.batchId,
    createdAt: now,
    intentCommitment: residual.intentCommitment,
    marketId: residual.marketId,
    matchingPayloadCommitment: matchingPayloadCommitment(residual),
    noteNullifier: residual.noteNullifier,
    ownerCommitment: residual.ownerCommitment,
    sourceIntentCommitment: residual.sourceIntentCommitment ?? residual.intentCommitment,
    updatedAt: now,
  }));
}
