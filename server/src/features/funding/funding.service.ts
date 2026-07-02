import type { FundingUpdateRecord } from "@pnlx/protocol-types";
import type { ServerEnv } from "@/config/env";
import { assertProtocolAdmin } from "@/shared/http/auth-context";
import { FundingEngineService } from "@/workers/funding-engine/funding-engine.service";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { AdvanceFundingInput, RunFundingInput, RunFundingResult } from "@/features/funding/funding.model";

export class FundingService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly env: ServerEnv,
    private readonly engine = new FundingEngineService(executor),
  ) {}

  advance(input: AdvanceFundingInput, authenticated?: string): FundingUpdateRecord {
    assertProtocolAdmin(authenticated, this.env.protocolAdminAddresses, {
      required: this.env.protocolAdminRequired,
    });
    if (input.fundingDelta === 0n) throw new Error("funding delta cannot be zero");

    const market = this.executor.store.markets.get(input.marketId);
    if (!market) throw new Error("unknown market");

    const record: FundingUpdateRecord = {
      appliedAt: input.appliedAt ?? Date.now(),
      fundingDelta: input.fundingDelta,
      marketId: market.marketId,
      newFundingIndex: market.fundingIndex + input.fundingDelta,
      oldFundingIndex: market.fundingIndex,
    };
    this.executor.store.updateMarket({
      ...market,
      fundingIndex: record.newFundingIndex,
    });
    this.executor.store.addFundingUpdate(record);
    return record;
  }

  list(): FundingUpdateRecord[] {
    return [...this.executor.store.fundingUpdates.values()];
  }

  run(input: RunFundingInput, authenticated?: string): RunFundingResult {
    assertProtocolAdmin(authenticated, this.env.protocolAdminAddresses, {
      required: this.env.protocolAdminRequired,
    });
    return this.engine.runOnce(input);
  }
}
