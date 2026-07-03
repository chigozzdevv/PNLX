import type { IntentRecord, IntentValidityRecord, IntentValidityWitness, TradeIntent } from "@pnlx/protocol-types";

export interface CreateIntentInput {
  intent: TradeIntent;
  validity: IntentValidityRecord;
}

export type ProveAndSubmitIntentInput = IntentValidityWitness;

export interface ProveAndSubmitIntentResult {
  intent: IntentRecord;
  validity: IntentValidityRecord;
}
