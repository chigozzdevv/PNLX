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

  async settle(input: SettleBatchRequest, authenticated?: string): Promise<BatchSettlement> {
    this.assertAuthorized(authenticated);
    const settlement = await this.executor.createBatchSettlementAsync(input);
    const relay = await this.settleOnchain(settlement);
    return this.executor.commitBatchSettlement(withOnchainTransactions(settlement, relay));
  }

  async commitExternal(
    input: CommitExternalBatchSettlementRequest,
    authenticated?: string,
  ): Promise<BatchSettlement> {
    this.assertAuthorized(authenticated);
    this.executor.validateExternalBatchSettlement(input);
    const relay = await this.settleOnchain(input.settlement);
    return this.executor.commitExternalBatchSettlement({
      ...input,
      settlement: withOnchainTransactions(input.settlement, relay),
    }, {
      proofVerified: hasSubmittedProofVerification(relay) || !this.settlementConfig.settlementsOnchainRequired,
    });
  }

  private async settleOnchain(settlement: BatchSettlement): Promise<OnchainRelayResult | undefined> {
    if (this.onchain?.settleBatchAsync) return this.onchain.settleBatchAsync(settlement);
    return this.onchain?.settleBatch(settlement);
  }
}

function withOnchainTransactions(
  settlement: BatchSettlement,
  result: OnchainRelayResult | undefined,
): BatchSettlement {
  const {
    proofVerificationTxHash: _untrustedProofTxHash,
    settlementTxHash: _untrustedSettlementTxHash,
    ...verifiedSettlement
  } = settlement;
  const proofVerificationTxHash = result?.relays.find(
    (relay) => relay.functionName === "verify_and_record" && relay.submitted,
  )?.txHash;
  const settlementTxHash = result?.relays.find(
    (relay) => relay.functionName === "settle" && relay.kind === "batch-settlement" && relay.submitted,
  )?.txHash;
  return {
    ...verifiedSettlement,
    ...(proofVerificationTxHash ? { proofVerificationTxHash } : {}),
    ...(settlementTxHash ? { settlementTxHash } : {}),
  };
}

function hasSubmittedProofVerification(result: OnchainRelayResult | undefined): boolean {
  return Boolean(
    result?.relays.some((relay) =>
      relay.functionName === "verify_and_record" &&
      relay.submitted,
    ),
  );
}
