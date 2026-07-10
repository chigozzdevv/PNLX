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
    const targetUrl = jobsUrl(this.config.url);
    console.log(
      "[RemoteMatcherClient] matcher call",
      JSON.stringify({
        url: targetUrl,
        batchId: input.batchId,
        marketId: input.marketId,
      }),
    );

    let job = await this.request(targetUrl, { body: input, method: "POST" });
    const jobId = String(job.jobId ?? "");
    if (!jobId) throw new Error("remote matcher did not return a job id");
    while (job.status === "queued" || job.status === "proving") {
      await delay(2_000);
      job = await this.request(`${targetUrl}?id=${encodeURIComponent(jobId)}`, { method: "GET" });
    }
    if (job.status === "failed") {
      throw new Error(typeof job.error === "string" ? job.error : "remote matcher proof job failed");
    }
    if (!job.transcript || typeof job.transcript !== "object") {
      throw new Error("remote matcher completed without a settlement transcript");
    }
    return parseExternalBatchSettlement(job.transcript as Record<string, unknown>);
  }

  private async request(
    url: string,
    input: { body?: unknown; method: "GET" | "POST" },
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        headers: {
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
        },
        method: input.method,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`remote matcher request failed: ${message}`);
    }
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      throw new Error(`matcher response parse failed from ${url} with status ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string"
          ? body.error
          : `remote matcher service failed with status ${response.status}`,
      );
    }
    return body;
  }
}

function jobsUrl(base: string): string {
  return new URL("/match/jobs", base).toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
