import type {
  AccountEventRecord,
  AccountEncryptionKeyRecord,
  BatchExecutionRunRecord,
  BatchSettlement,
  ConditionalOrderCommitment,
  ConditionalOrderRecord,
  DisclosureRecord,
  FundingUpdateRecord,
  Hex,
  IntentRecord,
  LiquidationAutomationJobRecord,
  LiquidationRecord,
  MarketConfig,
  OrderLifecycleRecord,
  PendingAssetDepositRecord,
  PositionCloseRecord,
  PositionLifecycleRecord,
  PrivateMatchIntent,
  ProofMeta,
  ResidualOrderRecord,
  WithdrawalRecord,
} from "@pnlx/protocol-types";
import type { ProtocolStore } from "@/shared/state/store";

const ZERO_HEX = "0x0" as Hex;

export interface ProtocolStoreSnapshot {
  accountEvents: [Hex, AccountEventRecord][];
  accountEncryptionKeys: [Hex, AccountEncryptionKeyRecord][];
  batchExecutionRuns: [Hex, BatchExecutionRunRecord][];
  conditionalCloses: [Hex, ConditionalOrderRecord][];
  conditionalOrders: [Hex, ConditionalOrderCommitment][];
  disclosures: [Hex, DisclosureRecord][];
  fundingUpdates: [string, FundingUpdateRecord][];
  intents: [string, IntentRecord][];
  liquidationAutomationJobs: [Hex, LiquidationAutomationJobRecord][];
  liquidations: [Hex, LiquidationRecord][];
  marginCommitments: Hex[];
  markets: [string, MarketConfig][];
  orderLifecycle: [Hex, OrderLifecycleRecord][];
  pendingAssetDeposits: [Hex, PendingAssetDepositRecord][];
  positionCloses: [Hex, PositionCloseRecord][];
  positionCommitments: Hex[];
  positionLifecycle: [Hex, PositionLifecycleRecord][];
  privateMatchIntents?: [Hex, PrivateMatchIntent][];
  proofs: string[];
  residualOrders: [Hex, ResidualOrderRecord][];
  settlements: [string, BatchSettlement][];
  spentNullifiers: Hex[];
  withdrawals: [Hex, WithdrawalRecord][];
}

export function snapshotProtocolStore(store: ProtocolStore): ProtocolStoreSnapshot {
  return {
    accountEvents: [...store.accountEvents.entries()],
    accountEncryptionKeys: [...store.accountEncryptionKeys.entries()],
    conditionalCloses: [...store.conditionalCloses.entries()],
    conditionalOrders: [...store.conditionalOrders.entries()],
    disclosures: [...store.disclosures.entries()],
    fundingUpdates: [...store.fundingUpdates.entries()],
    liquidationAutomationJobs: [...store.liquidationAutomationJobs.entries()],
    batchExecutionRuns: [...store.batchExecutionRuns.entries()],
    intents: [...store.intents.entries()],
    liquidations: [...store.liquidations.entries()],
    marginCommitments: [...store.marginCommitments],
    markets: [...store.markets.entries()],
    orderLifecycle: [...store.orderLifecycle.entries()],
    pendingAssetDeposits: [...store.pendingAssetDeposits.entries()],
    positionCloses: [...store.positionCloses.entries()],
    positionCommitments: [...store.positionCommitments],
    positionLifecycle: [...store.positionLifecycle.entries()],
    privateMatchIntents: [...store.privateMatchIntents.entries()],
    proofs: [...store.proofs],
    residualOrders: [...store.residualOrders.entries()],
    settlements: [...store.settlements.entries()],
    spentNullifiers: [...store.spentNullifiers],
    withdrawals: [...store.withdrawals.entries()],
  };
}

export function applyProtocolStoreSnapshot(store: ProtocolStore, snapshot: Partial<ProtocolStoreSnapshot>): void {
  store.marginCommitments.clear();
  store.positionCommitments.clear();
  store.spentNullifiers.clear();
  store.intents.clear();
  store.residualOrders.clear();
  store.orderLifecycle.clear();
  store.positionLifecycle.clear();
  store.markets.clear();
  store.settlements.clear();
  store.liquidations.clear();
  store.conditionalOrders.clear();
  store.conditionalCloses.clear();
  store.positionCloses.clear();
  store.disclosures.clear();
  store.fundingUpdates.clear();
  store.liquidationAutomationJobs.clear();
  store.batchExecutionRuns.clear();
  store.withdrawals.clear();
  store.proofs.clear();
  store.accountEvents.clear();
  store.accountEncryptionKeys.clear();
  store.pendingAssetDeposits.clear();
  store.privateMatchIntents.clear();

  for (const [key, value] of snapshot.accountEvents ?? []) store.accountEvents.set(key, value);
  for (const [key, value] of snapshot.accountEncryptionKeys ?? []) store.accountEncryptionKeys.set(key, value);
  for (const [key, value] of snapshot.pendingAssetDeposits ?? []) store.pendingAssetDeposits.set(key, value);
  for (const value of snapshot.marginCommitments ?? []) store.marginCommitments.add(value);
  for (const value of snapshot.positionCommitments ?? []) store.positionCommitments.add(value);
  for (const value of snapshot.spentNullifiers ?? []) store.spentNullifiers.add(value);
  for (const [key, value] of snapshot.intents ?? []) {
    store.intents.set(key, {
      ...value,
      batchDigest: value.batchDigest ?? ZERO_HEX,
      marketDigest: value.marketDigest ?? ZERO_HEX,
      noteChangeCommitment: value.noteChangeCommitment ?? ZERO_HEX,
      ownerCommitmentField: value.ownerCommitmentField ?? ZERO_HEX,
    });
  }
  for (const [key, value] of snapshot.residualOrders ?? []) store.residualOrders.set(key, value);
  for (const [key, value] of snapshot.privateMatchIntents ?? []) {
    store.privateMatchIntents.set(key, {
      ...value,
      noteChangeCommitment: value.noteChangeCommitment ?? ZERO_HEX,
    });
  }
  for (const [key, value] of snapshot.orderLifecycle ?? []) store.orderLifecycle.set(key, value);
  for (const [key, value] of snapshot.positionLifecycle ?? []) store.positionLifecycle.set(key, value);
  for (const [key, value] of snapshot.markets ?? []) store.markets.set(key, value);
  for (const [key, value] of snapshot.settlements ?? []) {
    store.settlements.set(key, {
      ...value,
      matchTranscriptDigest: value.matchTranscriptDigest ?? ZERO_HEX,
      marginChangeCommitments: value.marginChangeCommitments ?? [],
      orderUpdates: value.orderUpdates ?? [],
      settlementDigest: value.settlementDigest ?? ZERO_HEX,
    });
  }
  for (const [key, value] of snapshot.liquidations ?? []) store.liquidations.set(key, value);
  for (const [key, value] of snapshot.conditionalOrders ?? []) store.conditionalOrders.set(key, value);
  for (const [key, value] of snapshot.conditionalCloses ?? []) store.conditionalCloses.set(key, value);
  for (const [key, value] of snapshot.positionCloses ?? []) store.positionCloses.set(key, value);
  for (const [key, value] of snapshot.disclosures ?? []) store.disclosures.set(key, value);
  for (const [key, value] of snapshot.fundingUpdates ?? []) store.fundingUpdates.set(key, value);
  for (const [key, value] of snapshot.liquidationAutomationJobs ?? []) {
    store.liquidationAutomationJobs.set(key, value);
  }
  for (const [key, value] of snapshot.batchExecutionRuns ?? []) store.batchExecutionRuns.set(key, value);
  for (const [key, value] of snapshot.withdrawals ?? []) store.withdrawals.set(key, value);
  for (const value of snapshot.proofs ?? []) store.proofs.add(value);
}

export function stringifyProtocolSnapshot(snapshot: ProtocolStoreSnapshot): string {
  return JSON.stringify(snapshot, bigintReplacer);
}

export function parseProtocolSnapshot(raw: string): ProtocolStoreSnapshot {
  return JSON.parse(raw, bigintReviver) as ProtocolStoreSnapshot;
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __pnlxBigInt: value.toString() } : value;
}

export function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__pnlxBigInt" in value &&
    typeof (value as { __pnlxBigInt: unknown }).__pnlxBigInt === "string"
  ) {
    return BigInt((value as { __pnlxBigInt: string }).__pnlxBigInt);
  }
  return value;
}
