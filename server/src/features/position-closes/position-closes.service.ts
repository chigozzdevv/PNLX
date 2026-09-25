import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { assertAuthenticatedOwnerCommitment } from "@/shared/http/auth-context";
import { assertFundingPayment } from "@/shared/protocol/funding";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import { createPositionCloseAccountEvent } from "@/shared/protocol/account-event-outcomes";
import { PRICE_SCALE } from "@pnlx/market-math";
import type { MarketConfig } from "@pnlx/protocol-types";
import { ownerCommitment } from "@pnlx/crypto";
import { preparePairedMakerClose, vaultMakerPairForTrader } from "@/features/position-closes/vault-maker-pair";
import {
  deleteUnsettledPendingMakerCloseOutput,
  finalizePendingMakerCloseOutput,
  insertPendingMakerNote,
  readMakerNotes,
} from "@/shared/maker-note-store";
import { readVaultMakerAllocations } from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import type {
  CreatePositionCloseInput,
  PositionCloseContextInput,
  PositionCloseContextResult,
  CreatePositionCloseResult,
  CreateProvenPositionCloseInput,
} from "@/features/position-closes/position-closes.model";

export class PositionClosesService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain?: OnchainRelayService,
    private readonly env: Pick<ServerEnv, "settlementsOnchainRequired"> &
      Partial<Pick<ServerEnv, "authRequired" | "makerWalletAddress" | "mongodbUri" |
        "collateralTokenContract" | "stellarDeploymentFile">> = {
      settlementsOnchainRequired: false,
    },
  ) {}

  context(input: PositionCloseContextInput, authenticated?: string): PositionCloseContextResult {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    const position = this.executor.store.positionsFor(input.ownerCommitment).find(
      (candidate) => candidate.positionCommitment === input.positionCommitment,
    );
    if (!position) throw new Error("position not found");
    if (position.status !== "open") throw new Error("position is not open");

    const membershipProof = this.executor.store.positionMembershipProof(input.positionCommitment);
    const positionRoot = this.executor.store.positionMembershipRoot();
    if (membershipProof.root !== positionRoot) throw new Error("position root is not current");
    const market = marketConfig(this.executor, position.marketId);
    const markPrice = this.currentMarkPrice(market);

    return {
      market: {
        fundingIndex: market.fundingIndex.toString(),
        marketId: market.marketId,
        markPrice: markPrice.toString(),
      },
      membershipProof,
      positionRoot,
    };
  }

  create(input: CreatePositionCloseInput): CreatePositionCloseResult {
    if (this.env.makerWalletAddress && this.onchain?.enabled) {
      throw new Error("vault-backed closes require the proven close route");
    }
    const record = this.prepare(input);
    return this.commit(record);
  }

  createManual(input: CreatePositionCloseInput): CreatePositionCloseResult {
    if (this.env.makerWalletAddress && this.onchain?.enabled) {
      throw new Error("vault-backed closes require the proven close route");
    }
    const record = this.prepare(input);
    return this.commitManual(record);
  }

  async createProven(
    input: CreateProvenPositionCloseInput,
    authenticated?: string,
  ): Promise<CreatePositionCloseResult> {
    this.validateProven(input);
    this.assertCloseOwner(input, authenticated);
    return (await this.commitPairedVaultMaker(input, true)) ?? this.commit(input);
  }

  async createManualProven(
    input: CreateProvenPositionCloseInput,
    authenticated?: string,
  ): Promise<CreatePositionCloseResult> {
    this.validateProven(input, { requireConditionalTrigger: false });
    this.assertCloseOwner(input, authenticated);
    return (await this.commitPairedVaultMaker(input, false)) ?? this.commitManual(input);
  }

  private assertCloseOwner(record: CreateProvenPositionCloseInput, authenticated?: string): void {
    const position = this.executor.store.positionFor(record.positionCommitment, record.positionNullifier);
    if (!position || position.positionCommitment !== record.positionCommitment ||
      position.positionNullifier !== record.positionNullifier || position.status !== "open") {
      throw new Error("position is not open");
    }
    assertAuthenticatedOwnerCommitment(authenticated, position.ownerCommitment, "position owner");
  }

  private async commitPairedVaultMaker(
    trader: CreateProvenPositionCloseInput,
    conditional: boolean,
  ): Promise<CreatePositionCloseResult | undefined> {
    if (!this.env.makerWalletAddress || !this.onchain?.enabled) return undefined;
    const maker = this.env.makerWalletAddress.trim().toUpperCase();
    const traderPosition = this.executor.store.positionFor(trader.positionCommitment, trader.positionNullifier);
    if (!traderPosition) throw new Error("position not found");
    if (traderPosition.ownerCommitment === ownerCommitment(maker)) {
      const settlement = [...this.executor.store.settlements.values()].find(
        (item) => item.settlementDigest === traderPosition.settlementDigest,
      );
      const index = settlement?.newCommitments.indexOf(trader.positionCommitment) ?? -1;
      const paired = index >= 0 ? this.executor.store.positionLifecycle.get(
        settlement!.newCommitments[index ^ 1]!,
      ) : undefined;
      if (index >= 0 && !paired) throw new Error("paired trader position is missing");
      if (paired?.status === "open") {
        throw new Error("vault maker position closes with its paired trader");
      }
      return undefined;
    }
    const settlement = [...this.executor.store.settlements.values()].find(
      (item) => item.settlementDigest === traderPosition.settlementDigest,
    );
    const pairIndex = settlement?.newCommitments.indexOf(trader.positionCommitment) ?? -1;
    const pairedPosition = pairIndex >= 0 ? this.executor.store.positionLifecycle.get(
      settlement!.newCommitments[pairIndex ^ 1]!,
    ) : undefined;
    if (pairIndex >= 0 && !pairedPosition) throw new Error("paired position is missing");
    if (pairedPosition?.ownerCommitment !== ownerCommitment(maker)) return undefined;
    if (!this.env.stellarDeploymentFile) throw new Error("vault maker deployment is unavailable");
    const deployment = loadDeploymentRegistry(this.env.stellarDeploymentFile);
    const vault = deployment?.contracts["liquidity-vault"];
    if (!vault || !this.env.collateralTokenContract || !this.env.mongodbUri) {
      throw new Error("vault maker close configuration is unavailable");
    }
    const [notes, allocations] = await Promise.all([readMakerNotes(), readVaultMakerAllocations()]);
    const pair = vaultMakerPairForTrader({
      allocations, asset: this.env.collateralTokenContract, maker, notes,
      store: this.executor.store, trader: traderPosition, vault,
    });
    if (!pair) return undefined;
    const market = marketConfig(this.executor, trader.marketId);
    const prepared = preparePairedMakerClose({
      fundingIndex: market.fundingIndex, makerNote: pair.makerNote,
      makerPosition: pair.makerPosition, markPrice: trader.markPrice,
      prover: this.prover, store: this.executor.store,
      traderCloseCommitment: trader.closeCommitment,
    });
    if (notes.some((note) => note.closePositionCommitment === pair.makerPosition.positionCommitment)) {
      throw new Error("vault maker close output already exists");
    }
    const note = {
      ...prepared.note,
      token: this.env.collateralTokenContract,
      shieldedPool: deployment.contracts["shielded-pool"],
      source: String(pair.makerNote.source ?? ""),
      vaultAllocationId: pair.allocation.id,
      vaultParentCommitment: String(pair.makerNote.commitment),
      updatedAt: Date.now(),
    };
    if (!note.shieldedPool) {
      throw new Error("vault maker close output is missing the shielded pool");
    }
    await insertPendingMakerNote(note);
    let relay: OnchainRelayResult;
    const settlementFunction = conditional ? "settle_pair_conditional" : "settle_pair_manual";
    try {
      relay = this.onchain.settlePairedPositionClose(trader, prepared.close, conditional);
      this.assertSubmittedSettlementRelay(relay, settlementFunction);
    } catch (error) {
      try {
        if (!this.onchain.isPositionCloseSettled(trader.closeCommitment) &&
          !this.onchain.isPositionCloseSettled(prepared.close.closeCommitment)) {
          await deleteUnsettledPendingMakerCloseOutput(
            note.commitment, pair.makerPosition.positionCommitment,
          );
        }
      } catch {
        // Preserve the pending note if the on-chain outcome cannot be verified.
      }
      throw error;
    }
    const committedTrader = withRelayEvidence(trader, relay, settlementFunction);
    const committedMaker = {
      ...withRelayEvidence(prepared.close, relay, settlementFunction),
      proofVerificationTxHash: relay.relays.filter((item) =>
        item.functionName === "verify_and_record" && item.submitted,
      )[1]?.txHash,
    };
    try {
      this.executor.store.recordProof(committedTrader.proof);
      this.executor.store.recordProof(committedMaker.proof);
      this.executor.store.addPairedPositionCloses(committedTrader, committedMaker, conditional);
      const accountEvent = this.accountEventFor(committedTrader);
      if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
      await (this.executor.store as { flush?: () => Promise<void> }).flush?.();
      await finalizePendingMakerCloseOutput(note.commitment, committedTrader.settlementTxHash!);
    } catch (error) {
      console.error("paired position close settled but reconciliation is pending", error);
    }
    return { ...committedTrader, txHash: committedTrader.settlementTxHash };
  }

  prepare(input: CreatePositionCloseInput): CreatePositionCloseResult {
    this.validate(input);
    return this.prover.provePositionClose(input);
  }

  commit(record: CreatePositionCloseResult): CreatePositionCloseResult {
    const accountEvent = this.accountEventFor(record);
    const relay = this.onchain?.settlePositionClose(record);
    this.assertSubmittedSettlementRelay(relay, "settle");
    const committed = withRelayEvidence(record, relay, "settle");
    this.executor.store.recordProof(committed.proof);
    this.executor.store.addPositionClose(committed);
    if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
    return { ...committed, txHash: committed.settlementTxHash };
  }

  commitManual(record: CreatePositionCloseResult): CreatePositionCloseResult {
    const accountEvent = this.accountEventFor(record);
    const relay = this.onchain?.settleManualPositionClose(record);
    this.assertSubmittedSettlementRelay(relay, "settle_manual");
    const committed = withRelayEvidence(record, relay, "settle_manual");
    this.executor.store.recordProof(committed.proof);
    this.executor.store.addManualPositionClose(committed);
    if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
    return { ...committed, txHash: committed.settlementTxHash };
  }

  validate(input: CreatePositionCloseInput): void {
    const market = marketConfig(this.executor, input.marketId);
    if (input.markPrice !== this.currentMarkPrice(market)) {
      throw new Error("position close mark price mismatch");
    }
    if (!this.executor.store.hasPositionMembershipRoot(input.positionRoot)) {
      throw new Error("position root is not recognized");
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
    if (input.markPrice !== this.currentMarkPrice(market)) {
      throw new Error("position close mark price mismatch");
    }
    if (!this.executor.store.hasPositionMembershipRoot(input.positionRoot)) {
      throw new Error("position root is not recognized");
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

  private currentMarkPrice(market: MarketConfig): bigint {
    return this.onchain?.enabled
      ? this.onchain.marketPrice(market.marketId)
      : market.oraclePrice;
  }

  private accountEventFor(record: CreatePositionCloseResult) {
    const position = this.executor.store.positionFor(record.positionCommitment, record.positionNullifier);
    if (!position) return undefined;
    const publicKey = this.executor.store.accountEncryptionKey(position.ownerCommitment)?.publicKey;
    if (!publicKey) return undefined;
    return createPositionCloseAccountEvent(record, position, publicKey);
  }
}

function withRelayEvidence(
  record: CreatePositionCloseResult,
  result: OnchainRelayResult | undefined,
  settlementFunction: "settle" | "settle_manual" | "settle_pair_manual" | "settle_pair_conditional",
): CreatePositionCloseResult {
  const proofVerificationTxHash = result?.relays.find(
    (relay) => relay.functionName === "verify_and_record" && relay.submitted,
  )?.txHash;
  const settlementTxHash = result?.relays.find(
    (relay) => relay.functionName === settlementFunction && relay.submitted,
  )?.txHash;
  return {
    ...record,
    ...(proofVerificationTxHash ? { proofVerificationTxHash } : {}),
    ...(settlementTxHash ? { settlementTxHash } : {}),
  };
}

function marketConfig(executor: ExecutorService, marketId: string): MarketConfig {
  const market = executor.store.markets.get(marketId);
  if (!market) throw new Error("unknown market");
  return market;
}
