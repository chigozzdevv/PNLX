import { json, readJson } from "../../shared/http/json";
import {
  parseDisclosureProof,
  parseIntentValidityProof,
  parseLiquidationProof,
  parseProofArtifactRegistration,
} from "./proofs.schema";
import type { ProofsService } from "./proofs.service";

export class ProofsController {
  constructor(private readonly proofs: ProofsService) {}

  verifiers(): Response {
    return json({ verifiers: this.proofs.verifiers() });
  }

  async liquidation(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ proof: this.proofs.liquidation(parseLiquidationProof(body)) });
  }

  async intent(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ proof: this.proofs.intent(parseIntentValidityProof(body)) });
  }

  async disclosure(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ proof: this.proofs.disclosure(parseDisclosureProof(body)) });
  }

  async registerArtifact(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    const artifact = this.proofs.registerArtifact(parseProofArtifactRegistration(body));
    return json(
      {
        artifact: {
          circuitId: artifact.circuitId,
          circuitKey: artifact.circuitKey,
          proofHash: artifact.proofHash,
          publicInputsHash: artifact.publicInputsHash,
          vkHash: artifact.vkHash,
        },
      },
      201,
    );
  }
}
