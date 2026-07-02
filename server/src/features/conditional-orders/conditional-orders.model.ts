import type {
  ConditionalOrderCommitment,
  ConditionalOrderRecord,
  ConditionalOrderWitness,
  PositionCloseRecord,
  PositionCloseWitness,
} from "@pnlx/protocol-types";

export type RegisterConditionalOrderInput = ConditionalOrderCommitment;
export type RegisterConditionalOrderResult = ConditionalOrderCommitment;
export type CreateConditionalOrderInput = ConditionalOrderWitness;
export type CreateConditionalOrderResult = ConditionalOrderRecord;
export type CreateProvenConditionalOrderInput = ConditionalOrderRecord;

export interface ExecuteConditionalCloseInput {
  close: PositionCloseWitness;
  trigger: ConditionalOrderWitness;
}

export interface ExecuteConditionalCloseResult {
  conditionalClose: ConditionalOrderRecord;
  positionClose: PositionCloseRecord;
}
