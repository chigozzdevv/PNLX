import { ProverService } from "./prover.service";

export function createProver(): ProverService {
  return new ProverService();
}
