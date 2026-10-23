import { parseExternalBatchSettlement } from "@/features/batches/batches.schema";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type {
  CreateExternalSettlementInput,
  MatcherGateway,
  RemoteMatcherConfig,
} from "@/workers/matcher/matcher.model";

export class RemoteMatcherClient implements MatcherGateway {
  private readonly jobTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly readRetries: number;

  constructor(private readonly config: RemoteMatcherConfig) {
    this.jobTimeoutMs = positiveMilliseconds(config.jobTimeoutMs, 15 * 60_000);
    this.pollIntervalMs = positiveMilliseconds(config.pollIntervalMs, 2_000);
    this.requestTimeoutMs = positiveMilliseconds(config.requestTimeoutMs, 30_000);
    this.readRetries = config.readRetries ?? 2;
    if (!Number.isSafeInteger(this.readRetries) || this.readRetries < 0 || this.readRetries > 5) {
      throw new Error("invalid remote matcher read retry count");
    }
  }

  async createSettlementTranscript(
    input: CreateExternalSettlementInput,
  ): Promise<ExternalBatchSettlementTranscript> {
    const targetUrl = jobsUrl(this.config.url);
    const deadline = Date.now() + this.jobTimeoutMs;
    // Creation is not blindly retried: the server deduplicates this exact batch input.
    let job = await this.request(targetUrl, { body: input, method: "POST" }, deadline);
    const jobId = String(job.jobId ?? "");
    if (!jobId) throw new Error("remote matcher did not return a job id");
    while (job.status === "queued" || job.status === "proving") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`remote matcher job deadline exceeded: ${jobId}`);
      await delay(Math.min(this.pollIntervalMs, remaining));
      job = await this.readJob(`${targetUrl}?id=${encodeURIComponent(jobId)}`, deadline);
    }
    if (job.status === "failed") {
      throw new Error(typeof job.error === "string" ? job.error : "remote matcher proof job failed");
    }
    if (job.status !== "completed") throw new Error("remote matcher returned an invalid job status");
    if (!job.transcript || typeof job.transcript !== "object") {
      throw new Error("remote matcher completed without a settlement transcript");
    }
    return parseExternalBatchSettlement(job.transcript as Record<string, unknown>);
  }

  private async readJob(url: string, deadline: number): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request(url, { method: "GET" }, deadline);
      } catch (error) {
        if (!(error instanceof RetryableReadError) || attempt >= this.readRetries) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("remote matcher job deadline exceeded");
        await delay(Math.min(this.pollIntervalMs * (attempt + 1), remaining));
      }
    }
  }

  private async request(
    url: string,
    input: { body?: unknown; method: "GET" | "POST" },
    deadline: number,
  ): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("remote matcher job deadline exceeded");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = async () => {
        const response = await fetch(url, {
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          headers: {
            ...(input.body === undefined ? {} : { "content-type": "application/json" }),
            ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
          },
          method: input.method,
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          if (input.method === "GET" && (response.status === 429 || response.status >= 500)) {
            throw new RetryableReadError(`remote matcher read failed with status ${response.status}`);
          }
          throw new Error(`remote matcher service failed with status ${response.status}`);
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`matcher response parse failed with status ${response.status}`);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("remote matcher returned an invalid response");
        }
        return body as Record<string, unknown>;
      };
      return await Promise.race([
        request(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new RetryableReadError("remote matcher request deadline exceeded"));
          }, Math.min(this.requestTimeoutMs, remaining));
        }),
      ]);
    } catch (error) {
      if (error instanceof RetryableReadError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (input.method === "GET" && error instanceof TypeError) {
        throw new RetryableReadError(`remote matcher request failed: ${message}`);
      }
      throw new Error(`remote matcher request failed: ${message}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

class RetryableReadError extends Error {}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("invalid remote matcher timeout");
  return result;
}

function jobsUrl(base: string): string {
  return new URL("/match/jobs", base).toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
