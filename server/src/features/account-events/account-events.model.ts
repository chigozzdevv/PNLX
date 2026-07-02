import type { AccountEventRecord, Hex } from "@pnlx/protocol-types";

export interface CreateAccountEventInput {
  ciphertext: string;
  dataCommitment: Hex;
  eventId: Hex;
  ownerCommitment: Hex;
}

export interface ListAccountEventsInput {
  ownerCommitment: Hex;
}

export type CreateAccountEventResult = AccountEventRecord;
export type ListAccountEventsResult = AccountEventRecord[];
