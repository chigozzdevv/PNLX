import { createHash } from "node:crypto";
import type {
  CommitteeSettlementInput,
  CommitteeSettlementTranscript,
} from "../../threshold-shares/threshold-shares.model";
import type { ProofCoordinatorService } from "../../proof-coordinator/proof-coordinator.service";
import type { BlindComputeGateway, NilccBlindComputeConfig } from "../matcher.model";
import { RemoteBlindComputeClient } from "../remote-compute/matcher.service";

export class NilccBlindComputeClient implements BlindComputeGateway {
  private attestationChecked = false;
  private readonly remote: RemoteBlindComputeClient;

  constructor(private readonly config: NilccBlindComputeConfig) {
    this.remote = new RemoteBlindComputeClient({
      token: config.token,
      url: config.workloadUrl,
    });
  }

  async createSettlementTranscript(
    input: CommitteeSettlementInput,
    proofs: ProofCoordinatorService,
  ): Promise<CommitteeSettlementTranscript> {
    await this.assertAttestation();
    return this.remote.createSettlementTranscript(input, proofs);
  }

  private async assertAttestation(): Promise<void> {
    if (this.attestationChecked || !this.config.attestationRequired) return;

    const response = await fetch(attestationReportUrl(this.config), {
      headers: {
        ...(this.config.attestationToken
          ? { authorization: `Bearer ${this.config.attestationToken}` }
          : {}),
      },
      method: "GET",
    });
    const report = await response.text();
    if (!response.ok) {
      throw new Error(`nilCC attestation report failed with ${response.status}`);
    }

    if (this.config.attestationReportSha256) {
      const digest = createHash("sha256").update(report).digest("hex");
      if (digest !== normalizeSha256(this.config.attestationReportSha256)) {
        throw new Error("nilCC attestation report digest mismatch");
      }
    }

    for (const expected of this.config.attestationContains) {
      if (!report.includes(expected)) {
        throw new Error("nilCC attestation report does not match pinned workload identity");
      }
    }

    this.attestationChecked = true;
  }
}

function attestationReportUrl(config: NilccBlindComputeConfig): string {
  if (config.attestationReportUrl) return config.attestationReportUrl;
  return new URL("/nilcc/api/v2/report", config.workloadUrl).toString();
}

function normalizeSha256(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}
