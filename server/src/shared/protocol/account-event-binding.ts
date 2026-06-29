import { hashFields } from "@merkl/crypto";
import type {
  AccountEventRecord,
  Hex,
  LiquidationRecord,
  PositionCloseRecord,
  PositionLifecycleRecord,
  ResidualOrderRecord,
} from "@merkl/protocol-types";

export type AccountEventBindingKind =
  | "liquidation"
  | "position-close"
  | "position-opening"
  | "residual-order";

export function positionOpeningAccountEventDataCommitment(
  opening: Pick<PositionLifecycleRecord, "ownerCommitment" | "positionCommitment" | "settlementDigest">,
  ciphertext: string,
): Hex {
  return hashFields("account-event-data:position-opening", [
    opening.settlementDigest,
    opening.positionCommitment,
    opening.ownerCommitment,
    ciphertext,
  ]);
}

export function positionOpeningAccountEventId(
  opening: Pick<PositionLifecycleRecord, "positionCommitment" | "settlementDigest">,
  dataCommitment: Hex,
): Hex {
  return hashFields("account-event:position-opening", [
    opening.settlementDigest,
    opening.positionCommitment,
    dataCommitment,
  ]);
}

export function residualOrderAccountEventDataCommitment(
  residual: Pick<ResidualOrderRecord, "intentCommitment" | "ownerCommitment" | "sourceIntentCommitment">,
  settlementDigest: Hex,
  ciphertext: string,
): Hex {
  return hashFields("account-event-data:residual-order", [
    settlementDigest,
    residual.intentCommitment,
    residual.sourceIntentCommitment,
    residual.ownerCommitment,
    ciphertext,
  ]);
}

export function residualOrderAccountEventId(
  residual: Pick<ResidualOrderRecord, "intentCommitment" | "sourceIntentCommitment">,
  settlementDigest: Hex,
  dataCommitment: Hex,
): Hex {
  return hashFields("account-event:residual-order", [
    settlementDigest,
    residual.intentCommitment,
    residual.sourceIntentCommitment,
    dataCommitment,
  ]);
}

export function positionCloseAccountEventDataCommitment(
  record: Pick<PositionCloseRecord, "closeCommitment" | "positionCommitment" | "positionNullifier">,
  ownerCommitment: Hex,
  ciphertext: string,
): Hex {
  return hashFields("account-event-data:position-close", [
    record.closeCommitment,
    record.positionCommitment,
    record.positionNullifier,
    ownerCommitment,
    ciphertext,
  ]);
}

export function positionCloseAccountEventId(
  record: Pick<PositionCloseRecord, "closeCommitment" | "positionNullifier">,
  dataCommitment: Hex,
): Hex {
  return hashFields("account-event:position-close", [
    record.closeCommitment,
    record.positionNullifier,
    dataCommitment,
  ]);
}

export function liquidationAccountEventDataCommitment(
  record: Pick<LiquidationRecord, "positionCommitment" | "positionNullifier" | "rewardCommitment">,
  ownerCommitment: Hex,
  ciphertext: string,
): Hex {
  return hashFields("account-event-data:liquidation", [
    record.positionCommitment,
    record.positionNullifier,
    record.rewardCommitment,
    ownerCommitment,
    ciphertext,
  ]);
}

export function liquidationAccountEventId(
  record: Pick<LiquidationRecord, "positionNullifier" | "rewardCommitment">,
  dataCommitment: Hex,
): Hex {
  return hashFields("account-event:liquidation", [
    record.positionNullifier,
    record.rewardCommitment,
    dataCommitment,
  ]);
}

export function assertPositionOpeningAccountEvent(
  opening: Pick<PositionLifecycleRecord, "ownerCommitment" | "positionCommitment" | "settlementDigest">,
  event: AccountEventRecord,
): void {
  if (event.ownerCommitment !== opening.ownerCommitment) {
    throw new Error("position account event owner mismatch");
  }
  const dataCommitment = positionOpeningAccountEventDataCommitment(opening, event.ciphertext);
  if (event.dataCommitment !== dataCommitment) {
    throw new Error("position account event data commitment mismatch");
  }
  if (event.eventId !== positionOpeningAccountEventId(opening, dataCommitment)) {
    throw new Error("position account event id mismatch");
  }
}

export function assertResidualOrderAccountEvent(
  residual: Pick<ResidualOrderRecord, "intentCommitment" | "ownerCommitment" | "sourceIntentCommitment">,
  settlementDigest: Hex,
  event: AccountEventRecord,
): void {
  if (event.ownerCommitment !== residual.ownerCommitment) {
    throw new Error("residual account event owner mismatch");
  }
  const dataCommitment = residualOrderAccountEventDataCommitment(residual, settlementDigest, event.ciphertext);
  if (event.dataCommitment !== dataCommitment) {
    throw new Error("residual account event data commitment mismatch");
  }
  if (event.eventId !== residualOrderAccountEventId(residual, settlementDigest, dataCommitment)) {
    throw new Error("residual account event id mismatch");
  }
}

export function assertPositionCloseAccountEvent(
  record: Pick<PositionCloseRecord, "closeCommitment" | "positionCommitment" | "positionNullifier">,
  ownerCommitment: Hex,
  event: AccountEventRecord,
): void {
  if (event.ownerCommitment !== ownerCommitment) {
    throw new Error("position close account event owner mismatch");
  }
  const dataCommitment = positionCloseAccountEventDataCommitment(record, ownerCommitment, event.ciphertext);
  if (event.dataCommitment !== dataCommitment) {
    throw new Error("position close account event data commitment mismatch");
  }
  if (event.eventId !== positionCloseAccountEventId(record, dataCommitment)) {
    throw new Error("position close account event id mismatch");
  }
}

export function assertLiquidationAccountEvent(
  record: Pick<LiquidationRecord, "positionCommitment" | "positionNullifier" | "rewardCommitment">,
  ownerCommitment: Hex,
  event: AccountEventRecord,
): void {
  if (event.ownerCommitment !== ownerCommitment) {
    throw new Error("liquidation account event owner mismatch");
  }
  const dataCommitment = liquidationAccountEventDataCommitment(record, ownerCommitment, event.ciphertext);
  if (event.dataCommitment !== dataCommitment) {
    throw new Error("liquidation account event data commitment mismatch");
  }
  if (event.eventId !== liquidationAccountEventId(record, dataCommitment)) {
    throw new Error("liquidation account event id mismatch");
  }
}
