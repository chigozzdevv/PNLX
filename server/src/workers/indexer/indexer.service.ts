import type { ProtocolStore } from "@/shared/state/store";
import type { BatchExecutionRunRecord, Hex, OrderLifecycleRecord } from "@pnlx/protocol-types";
import type {
  MarketPublicSnapshot,
  OwnerActivitySnapshot,
  OwnerOrderMatchingSnapshot,
  OwnerOrderSnapshot,
  OwnerPositionSnapshot,
  PublicSnapshot,
} from "@/workers/indexer/indexer.model";

export class IndexerService {
  constructor(private readonly store: ProtocolStore) {}

  snapshot(): PublicSnapshot {
    return {
      marginMembershipRoot: this.store.marginMembershipRoot(),
      marginRoot: this.store.marginRoot(),
      positionRoot: this.store.positionRoot(),
      marketCount: this.store.markets.size,
      markets: this.marketSnapshots(),
      settlementCount: this.store.settlements.size,
      conditionalOrderCount: this.store.conditionalOrders.size,
      conditionalCloseCount: this.store.conditionalCloses.size,
      positionCloseCount: this.store.positionCloses.size,
      liquidationCount: this.store.liquidations.size,
      disclosureCount: this.store.disclosures.size,
      accountEventCount: this.store.accountEvents.size,
      batchExecutionRunCount: this.store.batchExecutionRuns.size,
      positionLifecycleCount: this.store.positionLifecycle.size,
      spentNullifierCount: this.store.spentNullifiers.size,
    };
  }

  ordersFor(ownerCommitment: Hex, options: { activeOnly?: boolean } = {}): OwnerOrderSnapshot[] {
    const orders = [...this.store.orderLifecycle.values()]
      .filter((order) => order.ownerCommitment === ownerCommitment)
      .map((order) => {
        const residual = this.store.residualOrders.get(order.intentCommitment);
        const intent = this.store.intents.get(order.intentCommitment);
        return {
          batchId: order.batchId,
          cancellationTxHash: order.cancellationTxHash,
          createdAt: order.createdAt,
          intentCommitment: order.intentCommitment,
          isResidual: Boolean(residual),
          matching: this.matchingForOrder(order),
          matchingPayloadCommitment: intent?.matchingPayloadCommitment ??
            residual?.matchingPayloadCommitment ??
            "0x0",
          marketId: order.marketId,
          residualCommitment: order.residualCommitment,
          sourceIntentCommitment: residual?.sourceIntentCommitment,
          status: order.status,
          submissionTxHash: intent?.submissionTxHash,
          updatedAt: order.updatedAt,
        };
      });
    return (options.activeOnly ? orders.filter((order) => isActiveOrderStatus(order.status)) : orders)
      .sort((a, b) => a.batchId.localeCompare(b.batchId) || a.intentCommitment.localeCompare(b.intentCommitment));
  }

  private matchingForOrder(order: OrderLifecycleRecord): OwnerOrderMatchingSnapshot {
    if (!isActiveOrderStatus(order.status)) {
      return {
        message: "Order is no longer active",
        state: "settled",
      };
    }

    const latestRun = this.latestMatchingRunForOrder(order);
    if (!latestRun) {
      return {
        message: "Queued for matching",
        state: "queued",
      };
    }

    const base = {
      batchId: latestRun.batchId,
      completedAt: latestRun.completedAt,
      phase: latestRun.phase,
      reason: latestRun.reason,
      runId: latestRun.runId,
      status: latestRun.status,
    };

    if (latestRun.status === "failed") {
      return {
        ...base,
        message: blockedMessage(latestRun),
        state: "blocked",
      };
    }

    if (latestRun.status === "running") {
      const state = latestRun.phase === "proving"
        ? "proving"
        : latestRun.phase === "batch-settlement" || latestRun.phase === "settlement-commit" || latestRun.phase === "maker-finalize"
          ? "settling"
          : "matching";
      return {
        ...base,
        message: state === "proving" ? "Generating batch proof" : state === "settling" ? "Finalizing on-chain" : "Matching batch",
        state,
      };
    }

    if (latestRun.status === "skipped") {
      return {
        ...base,
        message: skippedMessage(latestRun.reason),
        state: latestRun.reason?.includes("batch has no crossed liquidity") ? "waiting-liquidity" : "queued",
      };
    }

    return {
      ...base,
      message: "Batch settled; refreshing position state",
      state: "settled",
    };
  }

  private latestMatchingRunForOrder(order: OrderLifecycleRecord): BatchExecutionRunRecord | undefined {
    return [...this.store.batchExecutionRuns.values()]
      .filter((run) =>
        run.marketId === order.marketId &&
        run.startedAt >= order.createdAt - 5_000
      )
      .sort((left, right) =>
        right.startedAt - left.startedAt ||
        (right.completedAt ?? right.updatedAt ?? right.startedAt) -
          (left.completedAt ?? left.updatedAt ?? left.startedAt) ||
        right.runId.localeCompare(left.runId)
      )[0];
  }

  positionsFor(ownerCommitment: Hex): OwnerPositionSnapshot[] {
    return this.store.positionsFor(ownerCommitment)
      .map((position) => {
        const settlement = this.store.settlementByDigest(position.settlementDigest);
        const close = position.closeCommitment
          ? this.store.positionCloses.get(position.closeCommitment)
          : undefined;
        const liquidation = position.status === "liquidated"
          ? this.store.liquidations.get(position.positionNullifier)
          : undefined;
        const lifecycle = close ?? liquidation;
        return {
          batchId: position.batchId,
          boundlessRequestId: settlement?.proof.boundlessRequestId,
          closeCommitment: position.closeCommitment,
          liquidationRewardCommitment: position.liquidationRewardCommitment,
          marginOutputCommitment: position.marginOutputCommitment,
          marketId: position.marketId,
          newPositionCommitment: position.newPositionCommitment,
          openedAt: position.openedAt,
          positionCommitment: position.positionCommitment,
          proofDigest: settlement?.proof.proofDigest,
          proofVerificationTxHash: settlement?.proofVerificationTxHash,
          journalDigest: settlement?.proof.journalDigest,
          lifecycleKind: close ? "close" as const : liquidation ? "liquidation" as const : undefined,
          lifecycleProofDigest: lifecycle?.proof.proofDigest,
          lifecycleProofSystem: lifecycle?.proof.proofSystem,
          lifecycleProofTxHash: lifecycle?.proofVerificationTxHash,
          lifecycleTxHash: lifecycle?.settlementTxHash,
          proofSystem: settlement?.proof.proofSystem,
          settlementDigest: position.settlementDigest,
          settlementTxHash: settlement?.settlementTxHash,
          sourceIntentCommitment: position.sourceIntentCommitment,
          status: position.status,
          updatedAt: position.updatedAt,
        };
      })
      .sort((a, b) => a.openedAt - b.openedAt || a.positionCommitment.localeCompare(b.positionCommitment));
  }

  activitiesFor(ownerCommitment: Hex): OwnerActivitySnapshot[] {
    const orders = this.ordersFor(ownerCommitment).map((order) => ({
      batchId: order.batchId,
      boundlessRequestId: undefined,
      id: order.intentCommitment,
      kind: "order" as const,
      marketId: order.marketId,
      residualCommitment: order.residualCommitment,
      status: order.status,
      timestamp: order.createdAt,
      txHash: order.cancellationTxHash ?? order.submissionTxHash,
      updatedAt: order.updatedAt,
    }));
    const ownerPositions = this.positionsFor(ownerCommitment);
    const positions = ownerPositions.map((position) => ({
      batchId: position.batchId,
      boundlessRequestId: position.boundlessRequestId,
      id: position.positionCommitment,
      kind: "position" as const,
      marketId: position.marketId,
      proofDigest: position.proofDigest,
      proofSystem: position.proofSystem,
      proofTxHash: position.proofVerificationTxHash,
      settlementDigest: position.settlementDigest,
      status: "open" as const,
      timestamp: position.openedAt,
      txHash: position.settlementTxHash,
      updatedAt: position.openedAt,
    }));
    const lifecycle = ownerPositions.flatMap((position) => {
      if (!position.lifecycleKind || !position.lifecycleProofDigest) return [];
      return [{
        batchId: position.batchId,
        id: position.closeCommitment ?? position.liquidationRewardCommitment ?? position.positionCommitment,
        kind: position.lifecycleKind === "close" ? "position-close" as const : "liquidation" as const,
        marketId: position.marketId,
        proofDigest: position.lifecycleProofDigest,
        proofSystem: position.lifecycleProofSystem,
        proofTxHash: position.lifecycleProofTxHash,
        status: position.lifecycleKind === "close" ? "closed" as const : "liquidated" as const,
        timestamp: position.updatedAt,
        txHash: position.lifecycleTxHash,
        updatedAt: position.updatedAt,
      }];
    });
    const accountEvents = this.store.accountEventsFor(ownerCommitment).map((event) => ({
      dataCommitment: event.dataCommitment,
      id: event.eventId,
      kind: "account-event" as const,
      timestamp: event.createdAt,
      updatedAt: event.createdAt,
    }));

    return [...orders, ...positions, ...lifecycle, ...accountEvents]
      .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }

  private marketSnapshots(): MarketPublicSnapshot[] {
    return [...this.store.markets.values()]
      .map((market) => {
        const settlements = [...this.store.settlements.values()].filter(
          (settlement) => settlement.marketId === market.marketId,
        );
        const aggregateVolume = settlements.reduce(
          (sum, settlement) => sum + settlement.aggregateVolume,
          0n,
        );
        const grossOpenInterest = settlements.reduce(
          (sum, settlement) => sum + settlement.openInterestDelta,
          0n,
        );

        return {
          aggregateVolume: aggregateVolume.toString(),
          conditionalCloseCount: countByMarket(this.store.conditionalCloses.values(), market.marketId),
          conditionalOrderCount: countByMarket(this.store.conditionalOrders.values(), market.marketId),
          fundingIndex: market.fundingIndex.toString(),
          grossOpenInterest: grossOpenInterest.toString(),
          initialMarginRate: market.initialMarginRate.toString(),
          liquidationCount: countByMarket(this.store.liquidations.values(), market.marketId),
          maintenanceMarginRate: market.maintenanceMarginRate.toString(),
          marketId: market.marketId,
          maxLeverage: market.maxLeverage.toString(),
          oraclePrice: market.oraclePrice.toString(),
          pendingIntentCount: [...this.store.orderLifecycle.values()].filter(
            (order) =>
              order.marketId === market.marketId &&
              (order.status === "open" || order.status === "partially-filled"),
          ).length,
          positionCloseCount: countByMarket(this.store.positionCloses.values(), market.marketId),
          settledBatchCount: settlements.length,
        };
      })
      .sort((a, b) => a.marketId.localeCompare(b.marketId));
  }
}

function isActiveOrderStatus(status: string): boolean {
  return status === "open" || status === "partially-filled";
}

function countByMarket<T extends { marketId: string }>(values: Iterable<T>, marketId: string): number {
  let count = 0;
  for (const value of values) {
    if (value.marketId === marketId) count += 1;
  }
  return count;
}

function blockedMessage(run: BatchExecutionRunRecord): string {
  const reason = run.reason ?? "matching failed";
  if (run.phase === "oracle" || reason.includes("oracle-price")) {
    return "Blocked: oracle relay failed";
  }
  if (run.phase === "maker-liquidity") {
    return "Blocked: maker liquidity failed";
  }
  if (run.phase === "matcher") {
    return "Blocked: matcher failed";
  }
  if (run.phase === "batch-settlement") {
    return "Blocked: batch settlement relay failed";
  }
  return `Blocked: ${cleanReason(reason)}`;
}

function skippedMessage(reason: string | undefined): string {
  if (reason?.includes("batch has no crossed liquidity")) return "Waiting for opposite-side liquidity";
  if (reason?.includes("batch has no active intents")) return "Waiting for matching";
  return reason ? cleanReason(reason) : "Queued for matching";
}

function cleanReason(reason: string): string {
  return reason
    .replace(/^(oracle|maker-liquidity|matcher|batch-settlement|settlement-commit|maker-finalize):\s*/, "")
    .replace(/^stellar relay failed \(([^)]+)\):\s*/, "$1 failed: ")
    .trim();
}
