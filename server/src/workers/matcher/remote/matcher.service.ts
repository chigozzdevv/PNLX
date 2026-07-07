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
    const targetUrl = matchUrl(this.config.url);
    console.log(
      "[RemoteMatcherClient] matcher call",
      JSON.stringify({
        url: targetUrl,
        batchId: input.batchId,
        marketId: input.marketId,
      }),
    );

    let response: Response;
    try {
      response = await fetch(targetUrl, {
        body: JSON.stringify(input),
        headers: {
          "content-type": "application/json",
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
        },
        method: "POST",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        "[RemoteMatcherClient] matcher request failed",
        JSON.stringify({
          url: targetUrl,
          message,
          type: error instanceof Error ? error.name : typeof error,
        }),
      );
      throw new Error(`remote matcher request failed: ${message}`);
    }

    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch (error) {
      console.error(
        "[RemoteMatcherClient] matcher response parse failed",
        JSON.stringify({
          url: targetUrl,
          status: response.status,
          preview: text.slice(0, 120),
          parseError: error instanceof Error ? error.message : String(error),
        }),
      );
      throw new Error(`matcher response parse failed from ${targetUrl} with status ${response.status}`);
    }

    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : `remote matcher service failed with status ${response.status}`;
      console.error(
        "[RemoteMatcherClient] matcher response non-ok",
        JSON.stringify({
          url: targetUrl,
          status: response.status,
          message,
        }),
      );
      throw new Error(message);
    }
    return parseExternalBatchSettlement(body);
  }
}

function matchUrl(base: string): string {
  return new URL("/match/settlement", base).toString();
}
