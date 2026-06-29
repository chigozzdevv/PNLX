import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProofArtifact } from "@merkl/proof-system";
import type { ProofMeta } from "@merkl/protocol-types";

interface ArtifactSnapshot {
  artifacts: [string, ProofArtifact][];
}

export class ProofArtifactRegistry {
  private readonly artifacts = new Map<string, ProofArtifact>();

  constructor(private readonly path = join(process.cwd(), ".merkl", "proof-artifacts.json")) {
    this.load();
  }

  get(proof: ProofMeta): ProofArtifact | undefined {
    this.load();
    const artifact = this.artifacts.get(proofKey(proof));
    if (!artifact) return undefined;
    if (!existsSync(artifact.proofPath) || !existsSync(artifact.publicInputsPath)) {
      return undefined;
    }
    return artifact;
  }

  set(proof: ProofMeta, artifact: ProofArtifact): void {
    this.artifacts.set(proofKey(proof), artifact);
    this.save();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const snapshot = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ArtifactSnapshot>;
    this.artifacts.clear();
    for (const [key, artifact] of snapshot.artifacts ?? []) {
      this.artifacts.set(key, artifact);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ artifacts: [...this.artifacts.entries()] }, null, 2));
    renameSync(tempPath, this.path);
  }
}

export function proofKey(proof: ProofMeta): string {
  return [
    proof.circuitKey,
    proof.verifierHash,
    proof.publicInputHash,
    proof.proofDigest,
  ].join(":");
}
