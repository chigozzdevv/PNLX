import { assertAuthenticatedOwnerCommitment } from "@/shared/http/auth-context";
import type { ExecutorService } from "@/workers/executor/executor.service";
import { createIndexer } from "@/workers/indexer/indexer.worker";
import type { PortfolioBalancesSnapshot, PortfolioInput, PortfolioSnapshot } from "@/features/portfolio/portfolio.model";

export class PortfolioService {
  constructor(private readonly executor: ExecutorService) {}

  get(input: PortfolioInput, authenticated?: string): PortfolioSnapshot {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    const indexer = createIndexer(this.executor.store);
    return {
      accountEvents: this.executor.store.accountEventsFor(input.ownerCommitment),
      activities: indexer.activitiesFor(input.ownerCommitment),
      orders: indexer.ordersFor(input.ownerCommitment),
      ownerCommitment: input.ownerCommitment,
      positions: indexer.positionsFor(input.ownerCommitment),
      publicState: indexer.snapshot(),
    };
  }

  orders(input: PortfolioInput, authenticated?: string) {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    return createIndexer(this.executor.store).ordersFor(input.ownerCommitment);
  }

  positions(input: PortfolioInput, authenticated?: string) {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    return createIndexer(this.executor.store).positionsFor(input.ownerCommitment);
  }

  activity(input: PortfolioInput, authenticated?: string) {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    return createIndexer(this.executor.store).activitiesFor(input.ownerCommitment);
  }

  balances(input: PortfolioInput, authenticated?: string): PortfolioBalancesSnapshot {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    return {
      accountEvents: this.executor.store.accountEventsFor(input.ownerCommitment),
      marginMembershipRoot: this.executor.store.marginMembershipRoot(),
      marginRoot: this.executor.store.marginRoot(),
      ownerCommitment: input.ownerCommitment,
      privateByDefault: true,
      serverReadableBalance: false,
    };
  }
}
