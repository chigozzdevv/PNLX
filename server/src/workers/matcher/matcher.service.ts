import type {
  AccountEncryptionKeyRecord,
  AccountEventRecord,
  BatchSettlement,
  IntentRecord,
  PrivateMatchIntent,
  PositionLifecycleRecord,
  ResidualOrderRecord,
} from "@pnlx/protocol-types";
import {
  createPositionOpeningAccountEvent,
  createResidualOrderAccountEvent,
} from "@/shared/protocol/account-event-outcomes";
import type { ProtocolStore } from "@/shared/state/store";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import {
  assertPrivateMatchIntent,
  matchingPayloadCommitment,
} from "@/workers/batch-matcher/private-intent";
import type {
  MatcherProviderGateway,
  CreateExternalSettlementInput,
  MatcherAccountEventEncryptor,
  MatcherAccountEventPayload,
  MatcherConfig,
  MatcherProviderTranscript,
  MatcherSettlementInput,
  MatcherSettlementTranscript,
  PrivatePositionOpeningEvent,
} from "@/workers/matcher/matcher.model";

export class MatcherService {
  private readonly accountEventEncryptor?: MatcherAccountEventEncryptor;
  private readonly provider: MatcherProviderGateway;

  constructor(
    private readonly store: ProtocolStore,
    private readonly proofs = new ProofCoordinatorService(),
    config: MatcherConfig = {},
  ) {
    this.accountEventEncryptor = config.accountEventEncryptor;
    this.provider = config.provider ?? new EmbeddedMatcherProviderGateway();
  }

  createSettlementTranscript(
    input: CreateExternalSettlementInput,
  ): ExternalBatchSettlementTranscript | Promise<ExternalBatchSettlementTranscript> {
    const market = this.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");

    const selected = input.intentCommitments ? new Set(input.intentCommitments) : undefined;
    const records = (input.records ??
      activeIntents(this.store, input.marketId, input.batchId, Boolean(input.includeOpenMarketOrders)))
      .filter((record) => !selected || selected.has(record.intentCommitment));
    const residuals = (input.residuals ?? activeResiduals(this.store, input.marketId, input.batchId))
      .filter((record) => !selected || selected.has(record.intentCommitment));
    if (records.length === 0 && residuals.length === 0) {
      throw new Error("batch has no active intents");
    }

    const computeInput: MatcherSettlementInput = {
      accountEncryptionKeys: accountEncryptionKeysFor(this.store, records, residuals),
      batchId: input.batchId,
      intents: privateMatchIntentsFor(this.store, input.batchId, records, residuals),
      market,
      records,
      residuals,
    };
    const transcript = this.provider.createSettlementTranscript(computeInput, this.proofs);
    return isPromiseLike(transcript)
      ? transcript.then((value) => this.finalizeProviderTranscript(value))
      : this.finalizeProviderTranscript(transcript);
  }

  private finalizeProviderTranscript(
    transcript: MatcherProviderTranscript,
  ): ExternalBatchSettlementTranscript {
    if (isExternalBatchSettlementTranscript(transcript)) {
      return transcript;
    }
    return this.finalizeTranscript(transcript);
  }

  private finalizeTranscript(transcript: MatcherSettlementTranscript): ExternalBatchSettlementTranscript {
    const accountEvents = createAccountEvents(
      transcript.positionOpenings,
      transcript.positionEvents,
      transcript.residualOrders,
      transcript.settlement.settlementDigest,
      this.accountEventEncryptor,
      (ownerCommitment) => this.store.accountEncryptionKey(ownerCommitment)?.publicKey,
    );
    const externalTranscript: ExternalBatchSettlementTranscript = {
      accountEvents,
      positionOpenings: transcript.positionOpenings,
      privateMatchIntents: transcript.privateMatchIntents,
      residualOrders: transcript.residualOrders,
      settlement: transcript.settlement,
    };

    return externalTranscript;
  }
}

class EmbeddedMatcherProviderGateway implements MatcherProviderGateway {
  private readonly matcher = new BatchMatcherService();

  createSettlementTranscript(
    input: MatcherSettlementInput,
    proofs: ProofCoordinatorService,
  ): Promise<MatcherSettlementTranscript> {
    const match = this.matcher.match({
      batchId: input.batchId,
      intents: input.intents,
      market: input.market,
    });
    const settlementInput = {
      batchId: input.batchId,
      intents: input.intents,
      market: input.market,
      match,
    };
    const proofTask = typeof proofs.createSettlementAsync === "function"
      ? proofs.createSettlementAsync(settlementInput)
      : Promise.resolve(proofs.createSettlement(settlementInput));
    return proofTask.then((settlement) => {
      const positionOpenings = createPositionOpenings(settlement, match.fills);
      return {
        positionEvents: createPositionEvents(match.fills, input.market.fundingIndex),
        positionOpenings,
        privateMatchIntents: match.residuals,
        residualOrders: createResidualOrderRecords(settlement, match.residuals),
        settlement,
      };
    });
  }
}

function createAccountEvents(
  positionOpenings: PositionLifecycleRecord[],
  positionEvents: PrivatePositionOpeningEvent[],
  residualOrders: ResidualOrderRecord[] | undefined,
  settlementDigest: `0x${string}`,
  encryptor: MatcherAccountEventEncryptor | undefined,
  keyForOwner: (ownerCommitment: `0x${string}`) => string | undefined,
): AccountEventRecord[] {
  const requiredCount = positionOpenings.length + (residualOrders?.length ?? 0);
  if (requiredCount === 0) return [];
  const eventEncryptor = encryptor
    ? (payload: unknown) => encryptor(payload as MatcherAccountEventPayload)
    : undefined;

  return [
    ...positionOpenings.map((opening) => {
      const positionEvent = positionEvents.find(
        (event) => event.positionCommitment === opening.positionCommitment,
      );
      if (!positionEvent) throw new Error("position account event payload is required");
      return createPositionOpeningAccountEvent(
        opening,
        positionEvent,
        keyForOwner(opening.ownerCommitment),
        eventEncryptor,
      );
    }),
    ...(residualOrders ?? []).map((residual) =>
      createResidualOrderAccountEvent(
        residual,
        settlementDigest,
        keyForOwner(residual.ownerCommitment),
        eventEncryptor,
      )
    ),
  ];
}

function activeIntents(
  store: ProtocolStore,
  marketId: string,
  batchId: string,
  includeOpenMarketOrders: boolean,
): IntentRecord[] {
  return [...store.intents.values()]
    .filter(
      (intent) =>
        (includeOpenMarketOrders || intent.batchId === batchId) &&
        intent.marketId === marketId &&
        store.orderLifecycle.get(intent.intentCommitment)?.status === "open",
    )
    .sort((left, right) =>
      left.batchId.localeCompare(right.batchId) || left.intentCommitment.localeCompare(right.intentCommitment)
    );
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

function createPositionEvents(
  fills: Array<{
    intentCommitment: `0x${string}`;
    marketId: string;
    margin: bigint;
    positionCommitment: `0x${string}`;
    positionNullifier: `0x${string}`;
    price: bigint;
    side: "long" | "short";
    size: bigint;
  }>,
  fundingIndex: bigint,
): PrivatePositionOpeningEvent[] {
  return fills.map((fill) => ({
    entryPrice: fill.price,
    fundingIndex,
    margin: fill.margin,
    marketId: fill.marketId,
    positionCommitment: fill.positionCommitment,
    positionNullifier: fill.positionNullifier,
    side: fill.side,
    size: fill.size,
    sourceIntentCommitment: fill.intentCommitment,
  }));
}

function createPositionOpenings(
  settlement: BatchSettlement,
  fills: Array<{
    intentCommitment: `0x${string}`;
    marketId: string;
    ownerCommitment: `0x${string}`;
    positionCommitment: `0x${string}`;
    positionNullifier: `0x${string}`;
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

function accountEncryptionKeysFor(
  store: ProtocolStore,
  records: IntentRecord[],
  residuals: ResidualOrderRecord[],
): AccountEncryptionKeyRecord[] {
  const owners = new Set([
    ...records.map((record) => record.ownerCommitment),
    ...residuals.map((residual) => residual.ownerCommitment),
  ]);
  return [...owners]
    .map((ownerCommitment) => store.accountEncryptionKey(ownerCommitment))
    .filter((record): record is AccountEncryptionKeyRecord => Boolean(record));
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === "function");
}

function isExternalBatchSettlementTranscript(
  transcript: MatcherProviderTranscript,
): transcript is ExternalBatchSettlementTranscript {
  return "accountEvents" in transcript;
}
