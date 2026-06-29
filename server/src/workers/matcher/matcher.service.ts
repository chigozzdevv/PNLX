import type { AccountEventRecord, IntentRecord, PositionLifecycleRecord, ResidualOrderRecord } from "@merkl/protocol-types";
import {
  positionOpeningAccountEventDataCommitment,
  positionOpeningAccountEventId,
  residualOrderAccountEventDataCommitment,
  residualOrderAccountEventId,
} from "../../shared/protocol/account-event-binding";
import { encryptAccountEventPayload } from "../../shared/protocol/account-event-encryption";
import { batchSettlementPublicInputHash } from "../../shared/protocol/batch-settlement-proof";
import { externalMatcherTranscriptHash } from "../../shared/protocol/external-matcher-transcript";
import { matcherAttestationMessage } from "../../shared/protocol/matcher-attestation";
import type { ProtocolStore } from "../../shared/state/store";
import type { ExternalBatchSettlementTranscript, ExternalMatcherAttestation } from "../executor/executor.model";
import type { ThresholdShareCommittee } from "../threshold-shares/threshold-shares.service";
import { ProofCoordinatorService } from "../proof-coordinator/proof-coordinator.service";
import type {
  BlindComputeGateway,
  CreateExternalSettlementInput,
  MatcherAccountEventEncryptor,
  MatcherConfig,
  MatcherSigner,
} from "./matcher.model";
import type {
  CommitteeSettlementInput,
  CommitteeSettlementTranscript,
  PrivatePositionOpeningEvent,
} from "../threshold-shares/threshold-shares.model";

export class MatcherService {
  private readonly accountEventEncryptor?: MatcherAccountEventEncryptor;
  private readonly compute: BlindComputeGateway;
  private readonly signers: MatcherSigner[];

  constructor(
    private readonly store: ProtocolStore,
    committee: ThresholdShareCommittee,
    private readonly proofs = new ProofCoordinatorService(),
    config: MatcherConfig = {},
  ) {
    this.accountEventEncryptor = config.accountEventEncryptor;
    this.compute = config.compute ?? new LocalThresholdComputeGateway(committee);
    this.signers = config.signers ?? [];
  }

  createSettlementTranscript(
    input: CreateExternalSettlementInput,
  ): ExternalBatchSettlementTranscript | Promise<ExternalBatchSettlementTranscript> {
    const market = this.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");

    const records = input.records ?? activeIntents(this.store, input.marketId);
    const residuals = input.residuals ?? activeResiduals(this.store, input.marketId, input.batchId);
    if (records.length === 0 && residuals.length === 0) {
      throw new Error("batch has no active intents");
    }

    const computeInput: CommitteeSettlementInput = {
      batchId: input.batchId,
      market,
      oldRoot: input.oldRoot ?? this.store.positionMembershipRoot(),
      positionCommitments: input.positionCommitments ?? [...this.store.positionCommitments],
      records,
      residuals,
    };
    const transcript = this.compute.createSettlementTranscript(computeInput, this.proofs);
    return isPromiseLike(transcript)
      ? transcript.then((value) => this.finalizeTranscript(value))
      : this.finalizeTranscript(transcript);
  }

  private finalizeTranscript(transcript: CommitteeSettlementTranscript): ExternalBatchSettlementTranscript {
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
      residualOrders: transcript.residualOrders,
      settlement: transcript.settlement,
    };

    return this.signers.length > 0
      ? this.attest(externalTranscript, this.signers)
      : externalTranscript;
  }

  attest(
    transcript: ExternalBatchSettlementTranscript,
    signers = this.signers,
  ): ExternalBatchSettlementTranscript {
    return {
      ...transcript,
      attestation: createMatcherAttestation(transcript, signers),
    };
  }
}

class LocalThresholdComputeGateway implements BlindComputeGateway {
  constructor(private readonly committee: ThresholdShareCommittee) {}

  createSettlementTranscript(
    input: CommitteeSettlementInput,
    proofs: ProofCoordinatorService,
  ): CommitteeSettlementTranscript {
    return this.committee.createSettlementTranscript(input, proofs);
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

  return [
    ...positionOpenings.map((opening) => {
      const positionEvent = positionEvents.find(
        (event) => event.positionCommitment === opening.positionCommitment,
      );
      if (!positionEvent) throw new Error("position account event payload is required");
      const ciphertext = encryptAccountEvent(
        { kind: "position-opening", opening: positionEvent },
        opening.ownerCommitment,
        encryptor,
        keyForOwner,
      );
      const dataCommitment = positionOpeningAccountEventDataCommitment(opening, ciphertext);
      return {
        ciphertext,
        createdAt: opening.openedAt,
        dataCommitment,
        eventId: positionOpeningAccountEventId(opening, dataCommitment),
        ownerCommitment: opening.ownerCommitment,
      };
    }),
    ...(residualOrders ?? []).map((residual) => {
      const ciphertext = encryptAccountEvent({ kind: "residual-order", residual, settlementDigest }, residual.ownerCommitment, encryptor, keyForOwner);
      const dataCommitment = residualOrderAccountEventDataCommitment(residual, settlementDigest, ciphertext);
      return {
        ciphertext,
        createdAt: residual.createdAt,
        dataCommitment,
        eventId: residualOrderAccountEventId(residual, settlementDigest, dataCommitment),
        ownerCommitment: residual.ownerCommitment,
      };
    }),
  ];
}

function encryptAccountEvent(
  payload: Parameters<MatcherAccountEventEncryptor>[0],
  ownerCommitment: `0x${string}`,
  encryptor: MatcherAccountEventEncryptor | undefined,
  keyForOwner: (ownerCommitment: `0x${string}`) => string | undefined,
): string {
  if (encryptor) return encryptor(payload);
  const publicKey = keyForOwner(ownerCommitment);
  if (!publicKey) throw new Error("account encryption key not found");
  return encryptAccountEventPayload(payload, publicKey);
}

export function createMatcherAttestation(
  transcript: ExternalBatchSettlementTranscript,
  signers: MatcherSigner[],
): ExternalMatcherAttestation {
  if (signers.length === 0) {
    throw new Error("external matcher attestation requires at least one signer");
  }

  const publicInputHash = batchSettlementPublicInputHash(transcript.settlement);
  const transcriptHash = externalMatcherTranscriptHash(transcript);
  const message = matcherAttestationMessage(transcript, publicInputHash, transcriptHash);

  return {
    publicInputHash,
    settlementDigest: transcript.settlement.settlementDigest,
    signatures: signers.map((signer) => ({
      signer: signer.address,
      signature: signer.sign(message),
    })),
    transcriptHash,
  };
}

function activeIntents(store: ProtocolStore, marketId: string): IntentRecord[] {
  return [...store.intents.values()].filter(
    (intent) =>
      intent.marketId === marketId &&
      store.orderLifecycle.get(intent.intentCommitment)?.status === "open",
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === "function");
}
