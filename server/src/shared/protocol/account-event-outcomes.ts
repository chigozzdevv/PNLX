import type {
  AccountEventRecord,
  Hex,
  LiquidationRecord,
  PositionCloseRecord,
  PositionLifecycleRecord,
} from "@merkl/protocol-types";
import {
  liquidationAccountEventDataCommitment,
  liquidationAccountEventId,
  positionCloseAccountEventDataCommitment,
  positionCloseAccountEventId,
} from "@/shared/protocol/account-event-binding";
import { encryptAccountEventPayload } from "@/shared/protocol/account-event-encryption";

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
