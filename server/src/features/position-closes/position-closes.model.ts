import type { Hex, PositionCloseRecord, PositionCloseWitness } from "@pnlx/protocol-types";

export type CreatePositionCloseInput = PositionCloseWitness;
export type CreatePositionCloseResult = PositionCloseRecord;
export type CreateProvenPositionCloseInput = PositionCloseRecord;

export interface PositionCloseContextInput {
  newPositionCommitment: Hex;
  ownerCommitment: Hex;
  positionCommitment: Hex;
}

export interface PositionCloseContextResult {
  membershipProof: {
    indices: boolean[];
    leaf: Hex;
    root: Hex;
    siblings: Hex[];
  };
  newPositionRoot: Hex;
  positionRoot: Hex;
}
