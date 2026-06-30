import type { AccountEncryptionKeyRecord, AccountEventRecord } from "@merkl/protocol-types";
import {
  createPositionOpeningAccountEvent,
  createResidualOrderAccountEvent,
} from "@/shared/protocol/account-event-outcomes";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type {
  CommitteeSettlementTranscript,
  PrivatePositionOpeningEvent,
} from "@/workers/threshold-shares/threshold-shares.model";
import { ThresholdShareCommittee } from "@/workers/threshold-shares/threshold-shares.service";
import { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";
import type { MatcherProviderConfig, MatcherProviderSettlementRequest } from "@/workers/matcher-provider/matcher-provider.model";

export class MatcherProviderService {
  private readonly committee: ThresholdShareCommittee;
  private readonly proofs = new ProofCoordinatorService();

  constructor(config: MatcherProviderConfig) {
    this.committee = new ThresholdShareCommittee({
      nodeIds: config.thresholdShareNodeIds,
      shareStoreDir: config.thresholdShareStoreDir,
      threshold: config.thresholdShareThreshold,
    });
  }

  createSettlementTranscript(input: MatcherProviderSettlementRequest): ExternalBatchSettlementTranscript {
    const transcript = this.committee.createSettlementTranscript(input, this.proofs);
    return {
      accountEvents: createAccountEvents(transcript, input.accountEncryptionKeys ?? []),
      positionOpenings: transcript.positionOpenings,
      residualOrders: transcript.residualOrders,
      settlement: transcript.settlement,
    };
  }
}

function createAccountEvents(
  transcript: CommitteeSettlementTranscript,
  keys: AccountEncryptionKeyRecord[],
): AccountEventRecord[] {
  const publicKeys = new Map(keys.map((record) => [record.ownerCommitment, record.publicKey]));
  return [
    ...transcript.positionOpenings.map((opening) => {
      const positionEvent = positionEventFor(transcript.positionEvents, opening.positionCommitment);
      return createPositionOpeningAccountEvent(
        opening,
        positionEvent,
        publicKeys.get(opening.ownerCommitment),
      );
    }),
    ...transcript.residualOrders.map((residual) =>
      createResidualOrderAccountEvent(
        residual,
        transcript.settlement.settlementDigest,
        publicKeys.get(residual.ownerCommitment),
      )
    ),
  ];
}

function positionEventFor(
  events: PrivatePositionOpeningEvent[],
  positionCommitment: `0x${string}`,
): PrivatePositionOpeningEvent {
  const event = events.find((entry) => entry.positionCommitment === positionCommitment);
  if (!event) throw new Error("position account event payload is required");
  return event;
}
