import { pnlxPost } from "@/lib/pnlx-api";
import type { Hex, ServerProofMeta } from "@/types/trading";

export interface ClientProofArtifactRegistration {
  bytecodeHash?: Hex;
  proof: ServerProofMeta;
  proofBase64: string;
  publicInputsBase64: string;
  vkBase64: string;
  witnessHash?: Hex;
}

export interface RegisteredProofArtifact {
  circuitId: string;
  circuitKey: Hex;
  proofHash: Hex;
  publicInputsHash: Hex;
  vkHash: Hex;
}

export async function registerClientProofArtifact(
  input: ClientProofArtifactRegistration,
  token?: string,
): Promise<RegisteredProofArtifact> {
  const result = await pnlxPost<{ artifact: RegisteredProofArtifact }>(
    "/proofs/artifacts",
    input,
    token,
  );
  return result.artifact;
}

export function bytesToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
