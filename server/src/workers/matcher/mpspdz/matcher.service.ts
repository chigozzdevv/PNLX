import { parseExternalBatchSettlement } from "@/features/batches/batches.schema";
import type {
  CommitteeSettlementInput,
} from "@/workers/threshold-shares/threshold-shares.model";
import type { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";
import type {
  MatcherProviderGateway,
  MatcherProviderTranscript,
  MpspdzMatcherProviderConfig,
} from "@/workers/matcher/matcher.model";
import {
  hasEncryptedAccountEvents,
  parseCommitteeSettlementTranscript,
} from "@/workers/matcher/custom/matcher.service";

type ComputeBody = Record<string, unknown>;

export class MpspdzMatcherProviderClient implements MatcherProviderGateway {
  constructor(private readonly config: MpspdzMatcherProviderConfig) {}

  async createSettlementTranscript(
    input: CommitteeSettlementInput,
    _proofs: ProofCoordinatorService,
  ): Promise<MatcherProviderTranscript> {
    const response = await fetch(mpspdzCoordinatorUrl(this.config.coordinatorUrl), {
      body: JSON.stringify({
        ...input,
        mpspdz: {
          partyUrls: this.config.partyUrls,
          protocol: this.config.protocol,
        },
      }, bigintReplacer),
      headers: {
        "content-type": "application/json",
        "x-merkl-mpspdz-party-count": String(this.config.partyUrls.length),
        "x-merkl-mpspdz-protocol": this.config.protocol,
        ...(this.config.token ? { authorization: `Bearer ${this.config.token}` } : {}),
      },
      method: "POST",
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as ComputeBody : {};
    if (!response.ok) {
      const message =
        typeof body.error === "string"
          ? body.error
          : `MP-SPDZ matcher provider failed with ${response.status}`;
      throw new Error(message);
    }
    return hasEncryptedAccountEvents(body)
      ? parseExternalBatchSettlement(body)
      : parseCommitteeSettlementTranscript(body);
  }
}

function mpspdzCoordinatorUrl(base: string): string {
  return new URL("/compute/settlement", base).toString();
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
