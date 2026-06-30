import type {
  AccountEventRecord,
  Hex,
  LiquidationRecord,
  PositionCloseRecord,
  PositionLifecycleRecord,
  ResidualOrderRecord,
} from "@merkl/protocol-types";
import {
  liquidationAccountEventDataCommitment,
  liquidationAccountEventId,
  positionCloseAccountEventDataCommitment,
  positionCloseAccountEventId,
  positionOpeningAccountEventDataCommitment,
  positionOpeningAccountEventId,
  residualOrderAccountEventDataCommitment,
  residualOrderAccountEventId,
} from "@/shared/protocol/account-event-binding";
import { encryptAccountEventPayload } from "@/shared/protocol/account-event-encryption";

export interface PositionOpeningAccountEventPayload {
  entryPrice: bigint;
  fundingIndex: bigint;
  margin: bigint;
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  side: "long" | "short";
  size: bigint;
  sourceIntentCommitment: Hex;
}

export type AccountEventPayloadEncryptor = (payload: unknown) => string;

export function createPositionOpeningAccountEvent(
  opening: PositionLifecycleRecord,
  event: PositionOpeningAccountEventPayload,
  publicKey: string | undefined,
  encryptor?: AccountEventPayloadEncryptor,
): AccountEventRecord {
  const ciphertext = encryptAccountEvent(
    { kind: "position-opening", opening: event },
    publicKey,
    encryptor,
  );
  const dataCommitment = positionOpeningAccountEventDataCommitment(opening, ciphertext);

  return {
    ciphertext,
    createdAt: opening.openedAt,
    dataCommitment,
    eventId: positionOpeningAccountEventId(opening, dataCommitment),
    ownerCommitment: opening.ownerCommitment,
  };
}

export function createResidualOrderAccountEvent(
  residual: ResidualOrderRecord,
  settlementDigest: Hex,
  publicKey: string | undefined,
  encryptor?: AccountEventPayloadEncryptor,
): AccountEventRecord {
  const ciphertext = encryptAccountEvent(
    { kind: "residual-order", residual, settlementDigest },
    publicKey,
    encryptor,
  );
  const dataCommitment = residualOrderAccountEventDataCommitment(residual, settlementDigest, ciphertext);

  return {
    ciphertext,
    createdAt: residual.createdAt,
    dataCommitment,
    eventId: residualOrderAccountEventId(residual, settlementDigest, dataCommitment),
    ownerCommitment: residual.ownerCommitment,
  };
}

export function createPositionCloseAccountEvent(
  record: PositionCloseRecord,
  position: PositionLifecycleRecord,
  publicKey: string,
  createdAt = Date.now(),
): AccountEventRecord {
  const ciphertext = encryptAccountEventPayload(
    {
      kind: "position-close",
      position: lifecyclePayload(position),
      positionClose: record,
    },
    publicKey,
  );
  const dataCommitment = positionCloseAccountEventDataCommitment(
    record,
    position.ownerCommitment,
    ciphertext,
  );

  return {
    ciphertext,
    createdAt,
    dataCommitment,
    eventId: positionCloseAccountEventId(record, dataCommitment),
    ownerCommitment: position.ownerCommitment,
  };
}

export function createLiquidationAccountEvent(
  record: LiquidationRecord,
  position: PositionLifecycleRecord,
  publicKey: string,
  createdAt = Date.now(),
): AccountEventRecord {
  const ciphertext = encryptAccountEventPayload(
    {
      kind: "liquidation",
      liquidation: record,
      position: lifecyclePayload(position),
    },
    publicKey,
  );
  const dataCommitment = liquidationAccountEventDataCommitment(
    record,
    position.ownerCommitment,
    ciphertext,
  );

  return {
    ciphertext,
    createdAt,
    dataCommitment,
    eventId: liquidationAccountEventId(record, dataCommitment),
    ownerCommitment: position.ownerCommitment,
  };
}

function lifecyclePayload(position: PositionLifecycleRecord): {
  marketId: string;
  ownerCommitment: Hex;
  positionCommitment: Hex;
  positionNullifier: Hex;
  status: PositionLifecycleRecord["status"];
} {
  return {
    marketId: position.marketId,
    ownerCommitment: position.ownerCommitment,
    positionCommitment: position.positionCommitment,
    positionNullifier: position.positionNullifier,
    status: position.status,
  };
}

function encryptAccountEvent(
  payload: unknown,
  publicKey: string | undefined,
  encryptor?: AccountEventPayloadEncryptor,
): string {
  if (encryptor) return encryptor(payload);
  if (!publicKey) throw new Error("account encryption key not found");
  return encryptAccountEventPayload(payload, publicKey);
}
