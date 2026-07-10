import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProofArtifact } from "@pnlx/proof-system";
import type { ProofMeta } from "@pnlx/protocol-types";

interface ArtifactSnapshot {
  artifacts: [string, ProofArtifact][];
}

interface ArtifactEntry {
  artifact: ProofArtifact;
  key: string;
}

export class ProofArtifactRegistry {
  private readonly artifacts = new Map<string, ProofArtifact>();

  constructor(private readonly path = join(process.cwd(), ".pnlx", "proof-artifacts.json")) {
    this.load();
  }

  get(proof: ProofMeta): ProofArtifact | undefined {
    const key = proofKey(proof);
    const artifact = this.readEntry(key) ?? this.loadLegacyEntry(key);
    if (!artifact) return undefined;
    if (!existsSync(artifact.proofPath) || !existsSync(artifact.publicInputsPath)) {
      return undefined;
    }
    return artifact;
  }

  set(proof: ProofMeta, artifact: ProofArtifact): void {
    const key = proofKey(proof);
    this.artifacts.set(key, artifact);
    this.writeEntry(key, artifact);
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const snapshot = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ArtifactSnapshot>;
    this.artifacts.clear();
    for (const [key, artifact] of snapshot.artifacts ?? []) {
      this.artifacts.set(key, artifact);
    }
  }

  private loadLegacyEntry(key: string): ProofArtifact | undefined {
    this.load();
    return this.artifacts.get(key);
  }

  private readEntry(key: string): ProofArtifact | undefined {
    const path = this.entryPath(key);
    if (!existsSync(path)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as Partial<ArtifactEntry>;
      return entry.key === key ? entry.artifact : undefined;
    } catch {
      return undefined;
    }
  }

  private writeEntry(key: string, artifact: ProofArtifact): void {
    const path = this.entryPath(key);
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ artifact, key } satisfies ArtifactEntry, null, 2));
    renameSync(tempPath, path);
  }

  private entryPath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(`${this.path}.d`, `${digest}.json`);
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
