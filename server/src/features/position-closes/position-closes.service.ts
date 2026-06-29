import { contractPublicInputHash, publicField, publicU128 } from "@merkl/proof-system";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { assertFundingPayment } from "@/shared/protocol/funding";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import { createPositionCloseAccountEvent } from "@/shared/protocol/account-event-outcomes";
import { PRICE_SCALE } from "@merkl/market-math";
import type { MarketConfig } from "@merkl/protocol-types";
import type {
  CreatePositionCloseInput,
  CreatePositionCloseResult,
  CreateProvenPositionCloseInput,
} from "@/features/position-closes/position-closes.model";

export class PositionClosesService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain?: OnchainRelayService,
    private readonly env: Pick<ServerEnv, "settlementsOnchainRequired"> = {
      settlementsOnchainRequired: false,
    },
  ) {}

  create(input: CreatePositionCloseInput): CreatePositionCloseResult {
    const record = this.prepare(input);
    return this.commit(record);
  }

  createManual(input: CreatePositionCloseInput): CreatePositionCloseResult {
    const record = this.prepare(input);
    return this.commitManual(record);
  }

  createProven(input: CreateProvenPositionCloseInput): CreatePositionCloseResult {
    this.validateProven(input);
    return this.commit(input);
  }

  createManualProven(input: CreateProvenPositionCloseInput): CreatePositionCloseResult {
    this.validateProven(input, { requireConditionalTrigger: false });
    return this.commitManual(input);
  }

  prepare(input: CreatePositionCloseInput): CreatePositionCloseResult {
    this.validate(input);
    return this.prover.provePositionClose(input);
  }

  commit(record: CreatePositionCloseResult): CreatePositionCloseResult {
    const accountEvent = this.accountEventFor(record);
    const relay = this.onchain?.settlePositionClose(record);
    this.assertSubmittedSettlementRelay(relay, "settle");
    this.executor.store.recordProof(record.proof);
    this.executor.store.addPositionClose(record);
    if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
    return record;
  }

  commitManual(record: CreatePositionCloseResult): CreatePositionCloseResult {
    const accountEvent = this.accountEventFor(record);
    const relay = this.onchain?.settleManualPositionClose(record);
    this.assertSubmittedSettlementRelay(relay, "settle_manual");
    this.executor.store.recordProof(record.proof);
    this.executor.store.addManualPositionClose(record);
    if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
    return record;
  }

  validate(input: CreatePositionCloseInput): void {
    const market = marketConfig(this.executor, input.marketId);
    if (input.markPrice !== market.oraclePrice) {
      throw new Error("position close mark price mismatch");
    }
    if (input.positionRoot !== this.executor.store.positionMembershipRoot()) {
      throw new Error("position root is not current");
    }
    const expectedNewRoot = this.executor.store.positionMembershipRootWith(input.newPositionCommitment);
    if (input.newPositionRoot !== expectedNewRoot) {
      throw new Error("new position root mismatch");
    }
    assertFundingPayment(
      input.fundingPayment,
      input.side,
      input.size,
      market.fundingIndex,
      input.fundingIndex,
    );
  }

  validateProven(
    input: CreateProvenPositionCloseInput,
    options: { requireConditionalTrigger?: boolean } = { requireConditionalTrigger: true },
  ): void {
    const market = marketConfig(this.executor, input.marketId);
    if (input.markPrice !== market.oraclePrice) {
      throw new Error("position close mark price mismatch");
    }
    if (input.positionRoot !== this.executor.store.positionMembershipRoot()) {
      throw new Error("position root is not current");
    }
    const expectedNewRoot = this.executor.store.positionMembershipRootWith(input.newPositionCommitment);
    if (input.newPositionRoot !== expectedNewRoot) {
      throw new Error("new position root mismatch");
    }
    if (options.requireConditionalTrigger ?? true) {
      const conditionalClose = this.executor.store.conditionalCloses.get(input.closeCommitment);
      if (!conditionalClose) {
        throw new Error("conditional close not triggered");
      }
      if (
        conditionalClose.marketId !== input.marketId ||
        conditionalClose.positionNullifier !== input.positionNullifier ||
        conditionalClose.markPrice !== input.markPrice
      ) {
        throw new Error("conditional close not triggered");
      }
    }
    if (input.proof.circuitId !== "position-close") {
      throw new Error("position close proof circuit mismatch");
    }
    this.prover.assertBoundProof(
      input.proof,
      "position-close",
      contractPublicInputHash([
        publicU128(input.markPrice),
        publicU128(PRICE_SCALE),
        publicField(input.positionRoot),
        publicField(input.positionCommitment),
        publicField(input.positionNullifier),
        publicField(input.closeCommitment),
        publicField(input.newPositionCommitment),
        publicField(input.newPositionRoot),
        publicField(input.marginOutputCommitment),
      ]),
    );
  }

  private assertSubmittedSettlementRelay(
    result: OnchainRelayResult | undefined,
    functionName: string,
  ): void {
    if (!this.env.settlementsOnchainRequired) return;
    if (!this.onchain || !this.onchain.enabled) {
      throw new Error("settlements require on-chain relay");
    }
    assertSubmittedRelay(result, functionName);
  }

  private accountEventFor(record: CreatePositionCloseResult) {
    const position = this.executor.store.positionFor(record.positionCommitment, record.positionNullifier);
    if (!position) return undefined;
    const publicKey = this.executor.store.accountEncryptionKey(position.ownerCommitment)?.publicKey;
    if (!publicKey) return undefined;
    return createPositionCloseAccountEvent(record, position, publicKey);
  }
}

function marketConfig(executor: ExecutorService, marketId: string): MarketConfig {
  const market = executor.store.markets.get(marketId);
  if (!market) throw new Error("unknown market");
  return market;
}
