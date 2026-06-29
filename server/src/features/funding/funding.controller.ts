import { authenticatedAddress } from "@/shared/http/auth-context";
import { json, readJson } from "@/shared/http/json";
import type { FundingService } from "@/features/funding/funding.service";
import { parseAdvanceFunding, parseRunFunding } from "@/features/funding/funding.schema";

export class FundingController {
  constructor(private readonly funding: FundingService) {}

  list(): Response {
    return json({ fundingUpdates: this.funding.list() });
  }

  async advance(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      { fundingUpdate: this.funding.advance(parseAdvanceFunding(body), authenticatedAddress(request)) },
      201,
    );
  }

  async run(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      { fundingCycle: this.funding.run(parseRunFunding(body), authenticatedAddress(request)) },
      201,
    );
  }
}
