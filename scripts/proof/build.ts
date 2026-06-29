import { buildProofArtifact, CIRCUITS, type CircuitId } from "@merkl/proof-system";

const requested = process.argv.slice(2);
const ids = requested.length > 0 ? requested : CIRCUITS.map((circuit) => circuit.id);
const validIds = new Set(CIRCUITS.map((circuit) => circuit.id));

for (const id of ids) {
  if (!validIds.has(id as CircuitId)) {
    throw new Error(`unknown circuit: ${id}`);
  }

  const artifact = buildProofArtifact(process.cwd(), id as CircuitId);
  console.log(
    JSON.stringify({
      circuitId: artifact.circuitId,
      circuitKey: artifact.circuitKey,
      proofHash: artifact.proofHash,
      vkHash: artifact.vkHash,
      publicInputsHash: artifact.publicInputsHash,
    }),
  );
}
