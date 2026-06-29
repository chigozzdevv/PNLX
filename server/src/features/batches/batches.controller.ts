import { json, readJson } from "@/shared/http/json";
import { authenticatedAddress } from "@/shared/http/auth-context";
import type { BatchesService } from "@/features/batches/batches.service";
import { parseExternalBatchSettlement, parseSettleBatch } from "@/features/batches/batches.schema";

export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  async settle(request: Request): Promise<Response> {
    const authenticated = authenticatedAddress(request);
    this.batches.assertAuthorized(authenticated);
    const body = await readJson<{
      batchId: string;
      marketId: string;
    }>(request);
    return json({ settlement: this.batches.settle(parseSettleBatch(body), authenticated) });
  }

  async settleExternal(request: Request): Promise<Response> {
    const authenticated = authenticatedAddress(request);
    this.batches.assertAuthorized(authenticated);
    const body = await readJson<Record<string, unknown>>(request);
    return json({
      settlement: this.batches.commitExternal(
        parseExternalBatchSettlement(body),
        authenticated,
      ),
    });
  }
}
