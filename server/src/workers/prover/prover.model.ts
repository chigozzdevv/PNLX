import type {
  ConditionalOrderRecord,
  ConditionalOrderWitness,
  DepositNoteRecord,
  DepositNoteWitness,
  DisclosureInput,
  DisclosureRecord,
  FundingSettlementRecord,
  Hex,
  IntentValidityRecord,
  IntentValidityWitness,
  LiquidationRecord,
  LiquidationWitness,
  PositionCloseRecord,
  PositionCloseWitness,
  PairedPositionCloseRecord,
  WithdrawalRecord,
  WithdrawalRequest,
} from "@pnlx/protocol-types";

export type ConditionalCloseProofInput = ConditionalOrderWitness;
export type LiquidationProofInput = LiquidationWitness;
export type PositionCloseProofInput = PositionCloseWitness;
export type DisclosureProofInput = DisclosureInput;
export type WithdrawalProofInput = WithdrawalRequest;
export type IntentValidityProofInput = IntentValidityWitness;
export type DepositNoteProofInput = DepositNoteWitness;

export interface FundingSettlementProofInput {
  cycleId?: Hex;
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
  proveFundingSettlementAsync?(input: FundingSettlementProofInput): Promise<FundingSettlementRecord>;
  proveIntentValidity(input: IntentValidityProofInput): IntentValidityRecord;
  proveIntentValidityAsync?(input: IntentValidityProofInput): Promise<IntentValidityRecord>;
  proveConditionalClose(input: ConditionalCloseProofInput): ConditionalOrderRecord;
  proveConditionalCloseAsync?(input: ConditionalCloseProofInput): Promise<ConditionalOrderRecord>;
  proveLiquidation(input: LiquidationProofInput): LiquidationRecord;
  provePositionClose(input: PositionCloseProofInput): PositionCloseRecord;
  provePositionClosePairAsync?(inputs: [PositionCloseProofInput, PositionCloseProofInput], maintenanceRate: bigint,
    liquidation?: boolean): Promise<PairedPositionCloseRecord>;
  provePositionClosePair?(inputs: [PositionCloseProofInput, PositionCloseProofInput], maintenanceRate: bigint,
    liquidation?: boolean): PairedPositionCloseRecord;
  proveDisclosure(input: DisclosureProofInput): DisclosureRecord;
  proveWithdrawal(input: WithdrawalProofInput): WithdrawalRecord;
}
