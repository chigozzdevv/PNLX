import type { IntentRecord, IntentValidityRecord, IntentValidityWitness, TradeIntent } from "@merkl/protocol-types";
import type { NodeShareSet } from "../../workers/mpc-node/mpc-node.model";

export interface CreateIntentInput {
  intent: TradeIntent;
  validity: IntentValidityRecord;
}

export interface CreateSharedIntentInput {
  record: IntentRecord;
  shareSets: NodeShareSet[];
  validity: IntentValidityRecord;
}

export type ProveAndSubmitIntentInput = IntentValidityWitness;

export interface ProveAndSubmitIntentResult {
  intent: IntentRecord;
  validity: IntentValidityRecord;
}
