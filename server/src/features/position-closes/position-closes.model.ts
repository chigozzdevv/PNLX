import type { Hex, PositionCloseRecord, PositionCloseWitness } from "@pnlx/protocol-types";

export type CreatePositionCloseInput = PositionCloseWitness;
export type CreatePositionCloseResult = PositionCloseRecord & { txHash?: Hex };
export type CreateProvenPositionCloseInput = PositionCloseRecord;

export interface PositionCloseContextInput {
  ownerCommitment: Hex;
  positionCommitment: Hex;
}

export interface PositionCloseContextResult {
  market: {
    fundingIndex: string;
    marketId: string;
    markPrice: string;
  };
  membershipProof: {
    indices: boolean[];
    leaf: Hex;
    root: Hex;
    siblings: Hex[];
  };
  positionRoot: Hex;
}
