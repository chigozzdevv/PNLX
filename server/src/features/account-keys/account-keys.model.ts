import type { AccountEncryptionKeyRecord, Hex } from "@merkl/protocol-types";

export interface UpsertAccountKeyInput {
  algorithm: "ecdh-p256-aes-gcm";
  ownerCommitment: Hex;
  publicKey: string;
}

export interface GetAccountKeyInput {
  ownerCommitment: Hex;
}

export type UpsertAccountKeyResult = AccountEncryptionKeyRecord;
export type GetAccountKeyResult = AccountEncryptionKeyRecord | null;
