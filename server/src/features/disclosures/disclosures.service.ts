import { contractPublicInputHash, publicField, publicU128 } from "@merkl/proof-system";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import type {
  CreateDisclosureInput,
  CreateDisclosureResult,
  CreateProvenDisclosureInput,
} from "@/features/disclosures/disclosures.model";

export class DisclosuresService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain?: OnchainRelayService,
    private readonly env: Pick<ServerEnv, "settlementsOnchainRequired"> = {
      settlementsOnchainRequired: false,
    },
  ) {}

  create(input: CreateDisclosureInput): CreateDisclosureResult {
    const record = this.prover.proveDisclosure(input);
    const relay = this.onchain?.disclose(record);
    this.assertSubmittedSettlementRelay(relay);
    this.executor.store.recordProof(record.proof);
    this.executor.store.addDisclosure(record);
    return record;
  }

  createProven(input: CreateProvenDisclosureInput): CreateDisclosureResult {
    if (input.proof.circuitId !== "disclosure") {
      throw new Error("disclosure proof circuit mismatch");
    }
    this.prover.assertBoundProof(
      input.proof,
      "disclosure",
      contractPublicInputHash([
        publicU128(input.threshold),
        publicField(input.subject),
        publicField(input.claimDigest),
        publicField(input.root),
      ]),
    );
    const relay = this.onchain?.disclose(input);
    this.assertSubmittedSettlementRelay(relay);
    this.executor.store.recordProof(input.proof);
    this.executor.store.addDisclosure(input);
    return input;
  }

  private assertSubmittedSettlementRelay(result: OnchainRelayResult | undefined): void {
    if (!this.env.settlementsOnchainRequired) return;
    if (!this.onchain || !this.onchain.enabled) {
      throw new Error("settlements require on-chain relay");
    }
    assertSubmittedRelay(result, "verify");
  }
}
