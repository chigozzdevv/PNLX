import type {
  ConditionalOrderWitness,
  MarginNote,
  PositionNote,
  TradeIntent,
  Hex,
} from "@pnlx/protocol-types";
import { hashFields } from "./hash";
import { digestToFieldHex, fieldHashPair, fieldHex } from "./field-merkle";

export function commitMargin(note: MarginNote): Hex {
  return hashFields("margin-note", [
    note.assetId,
    note.amount,
    note.owner,
    note.rho,
    note.blinding,
  ]);
}

export function commitPosition(note: PositionNote): Hex {
  return hashFields("position-note", [
    note.marketId,
    note.side,
    note.size,
    note.entryPrice,
    note.margin,
    note.fundingIndex,
    note.owner,
    note.rho,
    note.blinding,
  ]);
}

export function commitIntent(intent: TradeIntent): Hex {
  return circuitIntentCommitment(intentBindingFields(intent));
}

export interface CircuitIntentCommitmentInput {
  batchDigest: Hex;
  marketDigest: Hex;
  ownerCommitmentField: Hex;
  side: "long" | "short";
  size: bigint;
  limitPrice: bigint;
  margin: bigint;
  noteNullifier: Hex;
  nonceDigest: Hex;
  saltDigest: Hex;
}

export interface IntentBindingFields extends CircuitIntentCommitmentInput {
  intentCommitment: Hex;
}

export function intentBindingFields(intent: TradeIntent): IntentBindingFields {
  const fields = {
    batchDigest: digestToFieldHex(`batch:${intent.batchId}`),
    marketDigest: digestToFieldHex(`market:${intent.marketId}`),
    ownerCommitmentField: intentOwnerCommitmentField(ownerCommitment(intent.owner)),
    side: intent.side,
    size: intent.size,
    limitPrice: intent.limitPrice,
    margin: intent.margin,
    noteNullifier: intent.noteNullifier,
    nonceDigest: digestToFieldHex(`nonce:${intent.nonce}`),
    saltDigest: digestToFieldHex(`salt:${intent.salt}`),
  };

  return {
    ...fields,
    intentCommitment: circuitIntentCommitment(fields),
  };
}

export function intentOwnerCommitmentField(commitment: Hex): Hex {
  return fieldHex(BigInt(commitment));
}

export function circuitIntentCommitment(input: CircuitIntentCommitmentInput): Hex {
  const side = input.side === "long" ? 1n : 2n;
  const scope = fieldHashPair(
    fieldHashPair(input.batchDigest, input.marketDigest),
    fieldHashPair(input.ownerCommitmentField, side),
  );
  const economics = fieldHashPair(
    fieldHashPair(input.size, input.limitPrice),
    fieldHashPair(input.margin, input.noteNullifier),
  );
  const entropy = fieldHashPair(input.nonceDigest, input.saltDigest);
  return fieldHashPair(fieldHashPair(scope, economics), entropy);
}

export function commitConditionalOrder(order: ConditionalOrderWitness): Hex {
  return circuitConditionalOrderCommitment(conditionalOrderBindingFields(order));
}

export interface CircuitConditionalOrderCommitmentInput {
  marketDigest: Hex;
  positionNullifier: Hex;
  side: "long" | "short";
  kind: "take-profit" | "stop-loss";
  triggerPrice: bigint;
  size: bigint;
  reduceOnly: boolean;
  saltDigest: Hex;
}

export interface ConditionalOrderBindingFields extends CircuitConditionalOrderCommitmentInput {
  closeCommitment: Hex;
}

export function conditionalOrderBindingFields(
  order: ConditionalOrderWitness,
): ConditionalOrderBindingFields {
  const fields = {
    marketDigest: digestToFieldHex(`market:${order.marketId}`),
    positionNullifier: order.positionNullifier,
    side: order.side,
    kind: order.kind,
    triggerPrice: order.triggerPrice,
    size: order.size,
    reduceOnly: order.reduceOnly,
    saltDigest: digestToFieldHex(`salt:${order.salt}`),
  };

  return {
    ...fields,
    closeCommitment: circuitConditionalOrderCommitment(fields),
  };
}

export function circuitConditionalOrderCommitment(
  input: CircuitConditionalOrderCommitmentInput,
): Hex {
  const side = input.side === "long" ? 1n : 2n;
  const kind = input.kind === "take-profit" ? 1n : 2n;
  const reduceOnly = input.reduceOnly ? 1n : 0n;
  const scope = fieldHashPair(
    fieldHashPair(input.marketDigest, input.positionNullifier),
    fieldHashPair(side, kind),
  );
  const trigger = fieldHashPair(
    fieldHashPair(input.triggerPrice, input.size),
    fieldHashPair(reduceOnly, input.saltDigest),
  );
  return fieldHashPair(scope, trigger);
}

export function ownerCommitment(owner: string): Hex {
  return hashFields("owner", [owner]);
}
