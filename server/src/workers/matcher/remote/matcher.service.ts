import { parseExternalBatchSettlement } from "@/features/batches/batches.schema";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type {
  CreateExternalSettlementInput,
  MatcherGateway,
  RemoteMatcherConfig,
} from "@/workers/matcher/matcher.model";

export class RemoteMatcherClient implements MatcherGateway {
  constructor(private readonly config: RemoteMatcherConfig) {}

  async createSettlementTranscript(
    input: CreateExternalSettlementInput,
  ): Promise<ExternalBatchSettlementTranscript> {
    const response = await fetch(matchUrl(this.config.url), {
      body: JSON.stringify(input),
      headers: {
        "content-type": "application/json",
        ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
      },
      method: "POST",
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : `remote matcher service failed with ${response.status}`;
      throw new Error(message);
    }
    return parseExternalBatchSettlement(body);
  }
}

function matchUrl(base: string): string {
  return new URL("/match/settlement", base).toString();
}
