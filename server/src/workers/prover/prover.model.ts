import type {
  ConditionalOrderRecord,
  ConditionalOrderWitness,
  DepositNoteRecord,
  DepositNoteWitness,
  DisclosureInput,
  DisclosureRecord,
  FundingSettlementRecord,
  IntentValidityRecord,
  IntentValidityWitness,
  LiquidationRecord,
  LiquidationWitness,
  PositionCloseRecord,
  PositionCloseWitness,
  WithdrawalRecord,
  WithdrawalRequest,
} from "@merkl/protocol-types";

export type ConditionalCloseProofInput = ConditionalOrderWitness;
export type LiquidationProofInput = LiquidationWitness;
export type PositionCloseProofInput = PositionCloseWitness;
export type DisclosureProofInput = DisclosureInput;
export type WithdrawalProofInput = WithdrawalRequest;
export type IntentValidityProofInput = IntentValidityWitness;
export type DepositNoteProofInput = DepositNoteWitness;

export interface FundingSettlementProofInput {
  appliedAt: number;
  elapsedMs: number;
  intervalMs: number;
  markPrice: bigint;
  marketId: string;
  maxFundingDelta?: bigint;
  newFundingIndex: bigint;
  oldFundingIndex: bigint;
  premiumRate: bigint;
}

export interface Prover {
  proveDepositNote(input: DepositNoteProofInput): DepositNoteRecord;
  proveFundingSettlement(input: FundingSettlementProofInput): FundingSettlementRecord;
  proveIntentValidity(input: IntentValidityProofInput): IntentValidityRecord;
  proveConditionalClose(input: ConditionalCloseProofInput): ConditionalOrderRecord;
  proveLiquidation(input: LiquidationProofInput): LiquidationRecord;
  provePositionClose(input: PositionCloseProofInput): PositionCloseRecord;
  proveDisclosure(input: DisclosureProofInput): DisclosureRecord;
  proveWithdrawal(input: WithdrawalProofInput): WithdrawalRecord;
}
