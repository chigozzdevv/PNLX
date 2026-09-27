import type { Hex } from "@pnlx/protocol-types";
import { positionMerkleProof, positionMerkleRoot,
  type FieldMerkleProof } from "./field-merkle";
export { secureMarginCommitment, secureMarginNullifier } from "./secure-margin-commitment";
export type { SecureMarginNote } from "./secure-margin-commitment";

export function secureMarginRoot(commitments: Hex[]): Hex {
  return positionMerkleRoot(commitments, 20);
}

export function secureMarginProof(commitments: Hex[], commitment: Hex): FieldMerkleProof {
  return positionMerkleProof(commitments, commitment, 20);
}
