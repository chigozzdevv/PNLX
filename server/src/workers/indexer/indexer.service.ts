import type { ProtocolStore } from "@/shared/state/store";
import type { Hex } from "@pnlx/protocol-types";
import type {
  MarketPublicSnapshot,
  OwnerActivitySnapshot,
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

  ordersFor(ownerCommitment: Hex): OwnerOrderSnapshot[] {
    return [...this.store.orderLifecycle.values()]
      .filter((order) => order.ownerCommitment === ownerCommitment)
      .map((order) => {
        const residual = this.store.residualOrders.get(order.intentCommitment);
        return {
          batchId: order.batchId,
          createdAt: order.createdAt,
          intentCommitment: order.intentCommitment,
          isResidual: Boolean(residual),
          marketId: order.marketId,
          residualCommitment: order.residualCommitment,
          shareCommitment: this.store.intents.get(order.intentCommitment)?.shareCommitment ??
            residual?.shareCommitment ??
            "0x0",
          sourceIntentCommitment: residual?.sourceIntentCommitment,
          status: order.status,
          updatedAt: order.updatedAt,
        };
      })
      .sort((a, b) => a.batchId.localeCompare(b.batchId) || a.intentCommitment.localeCompare(b.intentCommitment));
  }

  positionsFor(ownerCommitment: Hex): OwnerPositionSnapshot[] {
    return this.store.positionsFor(ownerCommitment)
      .map((position) => ({
        batchId: position.batchId,
        closeCommitment: position.closeCommitment,
        liquidationRewardCommitment: position.liquidationRewardCommitment,
        marginOutputCommitment: position.marginOutputCommitment,
        marketId: position.marketId,
        newPositionCommitment: position.newPositionCommitment,
        openedAt: position.openedAt,
        positionCommitment: position.positionCommitment,
        settlementDigest: position.settlementDigest,
        sourceIntentCommitment: position.sourceIntentCommitment,
        status: position.status,
        updatedAt: position.updatedAt,
      }))
      .sort((a, b) => a.openedAt - b.openedAt || a.positionCommitment.localeCompare(b.positionCommitment));
  }

  activitiesFor(ownerCommitment: Hex): OwnerActivitySnapshot[] {
    const orders = this.ordersFor(ownerCommitment).map((order) => ({
      batchId: order.batchId,
      id: order.intentCommitment,
      kind: "order" as const,
      marketId: order.marketId,
      residualCommitment: order.residualCommitment,
      status: order.status,
      timestamp: order.createdAt,
      updatedAt: order.updatedAt,
    }));
    const positions = this.positionsFor(ownerCommitment).map((position) => ({
      batchId: position.batchId,
      id: position.positionCommitment,
      kind: "position" as const,
      marketId: position.marketId,
      status: position.status,
      timestamp: position.openedAt,
      updatedAt: position.updatedAt,
    }));
    const accountEvents = this.store.accountEventsFor(ownerCommitment).map((event) => ({
      dataCommitment: event.dataCommitment,
      id: event.eventId,
      kind: "account-event" as const,
      timestamp: event.createdAt,
      updatedAt: event.createdAt,
    }));

    return [...orders, ...positions, ...accountEvents]
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

function countByMarket<T extends { marketId: string }>(values: Iterable<T>, marketId: string): number {
  let count = 0;
  for (const value of values) {
    if (value.marketId === marketId) count += 1;
  }
  return count;
}
