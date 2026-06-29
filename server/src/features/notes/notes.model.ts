import type {
  AssetWithdrawalRecord,
  AssetWithdrawalRequest,
  DepositNoteRecord,
  Hex,
  PendingAssetDepositRecord,
  WithdrawalRecord,
  WithdrawalRequest,
} from "@merkl/protocol-types";
import type { OnchainRelayResult, PreparedOnchainAction } from "@/workers/onchain/onchain.model";

export interface DepositNoteInput {
  commitment: Hex;
}

export interface DepositNoteResult {
  commitment: Hex;
  membershipProof: {
    indices: boolean[];
    leaf: Hex;
    root: Hex;
    siblings: Hex[];
  };
  membershipRoot: Hex;
  marginRoot: Hex;
}

export interface AssetDepositNoteInput {
  amount: bigint;
  autoSign?: boolean;
  blinding?: Hex;
  commitment: Hex;
  from: string;
  ownerDigest?: Hex;
  rhoDigest?: Hex;
  source?: string;
  token: string;
  tokenDigest?: Hex;
}

export interface ProvenAssetDepositNoteInput {
  amount: bigint;
  autoSign?: boolean;
  commitment: Hex;
  depositProof: DepositNoteRecord;
  from: string;
  source?: string;
  token: string;
}

export interface FinalizeAssetDepositInput extends ProvenAssetDepositNoteInput {
  relayId: Hex;
}

export interface PrepareAssetDepositResult {
  action: PreparedOnchainAction;
  depositProof: DepositNoteRecord;
  pendingDeposit: PendingAssetDepositRecord;
  proofVerification: OnchainRelayResult;
}

export interface AssetDepositNoteResult {
  amount: bigint;
  commitment: Hex;
  depositProof: DepositNoteRecord;
  from: string;
  membershipProof: {
    indices: boolean[];
    leaf: Hex;
    root: Hex;
    siblings: Hex[];
  };
  membershipRoot: Hex;
  marginRoot: Hex;
  onchain: OnchainRelayResult;
  token: string;
}

export type WithdrawNoteInput = WithdrawalRequest;
export type WithdrawNoteResult = WithdrawalRecord;
export type ProvenWithdrawNoteInput = WithdrawalRecord;
export type WithdrawAssetNoteInput = AssetWithdrawalRequest;
export type WithdrawAssetNoteResult = AssetWithdrawalRecord;
export type ProvenWithdrawAssetNoteInput = AssetWithdrawalRecord;
