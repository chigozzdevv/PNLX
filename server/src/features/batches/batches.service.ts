import type { BatchSettlement } from "@merkl/protocol-types";
import { assertProtocolAdmin } from "../../shared/http/auth-context";
import type { ServerEnv } from "../../config/env";
import { assertMatcherCommitteeAttestation } from "../../shared/protocol/matcher-attestation";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type { OnchainRelayService } from "../../workers/onchain/onchain.service";
import type { OnchainRelayResult } from "../../workers/onchain/onchain.model";
import type { CommitExternalBatchSettlementRequest, SettleBatchRequest } from "./batches.model";

export class BatchesService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly onchain?: OnchainRelayService,
    private readonly protocolAdminAddresses: string[] = [],
    private readonly protocolAdminRequired = false,
    private readonly matcherCommittee: Pick<
      ServerEnv,
      "matcherCommitteeAddresses" | "matcherCommitteeRequired" | "matcherCommitteeThreshold"
    > = {
      matcherCommitteeAddresses: [],
      matcherCommitteeRequired: false,
      matcherCommitteeThreshold: 0,
    },
  ) {}

  assertAuthorized(authenticated?: string): void {
    assertProtocolAdmin(authenticated, this.protocolAdminAddresses, {
      required: this.protocolAdminRequired,
    });
  }

  settle(input: SettleBatchRequest, authenticated?: string): BatchSettlement {
    this.assertAuthorized(authenticated);
    const settlement = this.executor.createBatchSettlement(input);
    this.onchain?.settleBatch(settlement);
    return this.executor.commitBatchSettlement(settlement);
  }

  commitExternal(input: CommitExternalBatchSettlementRequest, authenticated?: string): BatchSettlement {
    this.assertAuthorized(authenticated);
    assertMatcherCommitteeAttestation(input, {
      addresses: this.matcherCommittee.matcherCommitteeAddresses,
      required: this.matcherCommittee.matcherCommitteeRequired,
      threshold: this.matcherCommittee.matcherCommitteeThreshold,
    });
    this.executor.validateExternalBatchSettlement(input);
    const relay = this.onchain?.settleBatch(input.settlement);
    return this.executor.commitExternalBatchSettlement(input, {
      proofVerified: hasSubmittedProofVerification(relay),
    });
  }
}

function hasSubmittedProofVerification(result: OnchainRelayResult | undefined): boolean {
  return Boolean(
    result?.relays.some((relay) =>
      relay.functionName === "verify_and_record" &&
      relay.submitted,
    ),
  );
}
