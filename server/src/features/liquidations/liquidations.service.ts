import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { assertFundingPayment } from "@/shared/protocol/funding";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import { createLiquidationAccountEvent } from "@/shared/protocol/account-event-outcomes";
import { PRICE_SCALE, RATE_SCALE } from "@pnlx/market-math";
import type { MarketConfig } from "@pnlx/protocol-types";
import type {
  CreateLiquidationInput,
  CreateLiquidationResult,
  CreateProvenLiquidationInput,
} from "@/features/liquidations/liquidations.model";

export class LiquidationsService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain?: OnchainRelayService,
    private readonly env: Pick<ServerEnv, "settlementsOnchainRequired"> = {
      settlementsOnchainRequired: false,
    },
  ) {}

  create(input: CreateLiquidationInput): CreateLiquidationResult {
    this.validatePublicState(input);
    const market = marketConfig(this.executor, input.marketId);
    assertFundingPayment(
      input.fundingPayment,
      input.side,
      input.size,
      market.fundingIndex,
      input.fundingIndex,
    );
    const record = this.prover.proveLiquidation(input);
    const accountEvent = this.accountEventFor(record);
    const relay = this.onchain?.liquidate(record);
    this.assertSubmittedSettlementRelay(relay);
    this.executor.store.recordProof(record.proof);
    this.executor.store.addLiquidation(record);
    if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
    return record;
  }

  createProven(input: CreateProvenLiquidationInput): CreateLiquidationResult {
    this.validatePublicState(input);
    if (input.proof.circuitId !== "liquidation-check") {
      throw new Error("liquidation proof circuit mismatch");
    }
    this.prover.assertBoundProof(
      input.proof,
      "liquidation-check",
      contractPublicInputHash([
        publicU128(input.markPrice),
        publicU128(input.maintenanceRate),
        publicU128(PRICE_SCALE),
        publicU128(RATE_SCALE),
        publicField(input.positionRoot),
        publicField(input.positionCommitment),
        publicField(input.positionNullifier),
        publicField(input.rewardCommitment),
      ]),
    );
    const accountEvent = this.accountEventFor(input);
    const relay = this.onchain?.liquidate(input);
    this.assertSubmittedSettlementRelay(relay);
    this.executor.store.recordProof(input.proof);
    this.executor.store.addLiquidation(input);
    if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
    return input;
  }

  private assertSubmittedSettlementRelay(result: OnchainRelayResult | undefined): void {
    if (!this.env.settlementsOnchainRequired) return;
    if (!this.onchain || !this.onchain.enabled) {
      throw new Error("settlements require on-chain relay");
    }
    assertSubmittedRelay(result, "liquidate");
  }

  private validatePublicState(input: {
    marketId: string;
    markPrice: bigint;
    maintenanceRate: bigint;
    positionRoot: `0x${string}`;
  }): void {
    const market = marketConfig(this.executor, input.marketId);
    if (input.markPrice !== market.oraclePrice) {
      throw new Error("liquidation mark price mismatch");
    }
    if (input.maintenanceRate !== market.maintenanceMarginRate) {
      throw new Error("liquidation maintenance rate mismatch");
    }
    if (input.positionRoot !== this.executor.store.positionMembershipRoot()) {
      throw new Error("position root is not current");
    }
  }

  private accountEventFor(record: CreateLiquidationResult) {
    const position = this.executor.store.positionFor(record.positionCommitment, record.positionNullifier);
    if (!position) return undefined;
    const publicKey = this.executor.store.accountEncryptionKey(position.ownerCommitment)?.publicKey;
    if (!publicKey) return undefined;
    return createLiquidationAccountEvent(record, position, publicKey);
  }
}

function marketConfig(executor: ExecutorService, marketId: string): MarketConfig {
  const market = executor.store.markets.get(marketId);
  if (!market) throw new Error("unknown market");
  return market;
}
