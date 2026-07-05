import type { AccountEncryptionKeyRecord, Hex } from "@pnlx/protocol-types";
import type { AccountKeyRecoverySkip } from "@/features/account-keys/account-key-recovery";

export interface UpsertAccountKeyInput {
  algorithm: "ecdh-p256-aes-gcm";
  ownerCommitment: Hex;
  publicKey: string;
}

export interface GetAccountKeyInput {
  ownerCommitment: Hex;
}

export type RecoverAccountKeyInput = UpsertAccountKeyInput;

export interface RecoverAccountKeyResult {
  accountKey: AccountEncryptionKeyRecord;
  repairedEventCount: number;
  skipped: AccountKeyRecoverySkip[];
}

export type UpsertAccountKeyResult = AccountEncryptionKeyRecord;
export type GetAccountKeyResult = AccountEncryptionKeyRecord | null;
