import { parseExternalBatchSettlement } from "../../features/batches/batches.schema";
import type { ExternalBatchSettlementTranscript } from "../executor/executor.model";
import type {
  CreateExternalSettlementInput,
  ExternalMatcherGateway,
  RemoteExternalMatcherConfig,
} from "./external-matcher.model";

export class RemoteExternalMatcherClient implements ExternalMatcherGateway {
  constructor(private readonly config: RemoteExternalMatcherConfig) {}

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
          : `remote external matcher failed with ${response.status}`;
      throw new Error(message);
    }
    return parseExternalBatchSettlement(body);
  }
}

function matchUrl(base: string): string {
  return new URL("/match/settlement", base).toString();
}
