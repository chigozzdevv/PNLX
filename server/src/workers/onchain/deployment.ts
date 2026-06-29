import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentRegistry } from "./onchain.model";

export function loadDeploymentRegistry(path: string, root = process.cwd()): DeploymentRegistry | undefined {
  const resolved = path.startsWith("/") ? path : join(root, path);
  if (!existsSync(resolved)) return undefined;

  const deployment = JSON.parse(readFileSync(resolved, "utf8")) as Partial<DeploymentRegistry>;
  if (!deployment.contracts || !deployment.verifiers) {
    throw new Error(`invalid deployment registry: ${resolved}`);
  }

  return {
    contracts: deployment.contracts,
    network: String(deployment.network ?? ""),
    source: String(deployment.source ?? ""),
    sourceAddress: String(deployment.sourceAddress ?? ""),
    verifiers: deployment.verifiers,
  };
}
