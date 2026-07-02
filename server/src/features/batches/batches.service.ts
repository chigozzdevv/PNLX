import type { BatchSettlement } from "@pnlx/protocol-types";
import { assertProtocolAdmin } from "@/shared/http/auth-context";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { CommitExternalBatchSettlementRequest, SettleBatchRequest } from "@/features/batches/batches.model";

export class BatchesService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly onchain?: OnchainRelayService,
    private readonly protocolAdminAddresses: string[] = [],
    private readonly protocolAdminRequired = false,
    private readonly settlementConfig: Pick<
      ServerEnv,
      "settlementsOnchainRequired"
    > = {
      settlementsOnchainRequired: false,
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
    this.executor.validateExternalBatchSettlement(input);
    const relay = this.onchain?.settleBatch(input.settlement);
    return this.executor.commitExternalBatchSettlement(input, {
      proofVerified: hasSubmittedProofVerification(relay) || !this.settlementConfig.settlementsOnchainRequired,
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
