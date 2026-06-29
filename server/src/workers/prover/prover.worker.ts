import { ProverService } from "@/workers/prover/prover.service";

export function createProver(): ProverService {
  return new ProverService();
}
