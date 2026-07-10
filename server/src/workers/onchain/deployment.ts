import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";

export function loadDeploymentRegistry(path: string, root = process.cwd()): DeploymentRegistry | undefined {
  const resolved = path.startsWith("/") ? path : join(root, path);
  if (!existsSync(resolved)) return undefined;

  const deployment = JSON.parse(readFileSync(resolved, "utf8")) as Partial<DeploymentRegistry>;
  if (!deployment.contracts || !deployment.verifiers) {
    throw new Error(`invalid deployment registry: ${resolved}`);
  }
  if (
    deployment.verifiers["batch-match-risc0-verifier"] &&
    !deployment.risc0BatchMatchImageId
  ) {
    throw new Error(`deployment is missing risc0BatchMatchImageId: ${resolved}`);
  }

  return {
    contracts: deployment.contracts,
    network: String(deployment.network ?? ""),
    risc0BatchMatchImageId: deployment.risc0BatchMatchImageId,
    source: String(deployment.source ?? ""),
    sourceAddress: String(deployment.sourceAddress ?? ""),
    verifiers: deployment.verifiers,
  };
}
