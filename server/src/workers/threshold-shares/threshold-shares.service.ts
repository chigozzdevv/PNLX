import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hex, IntentRecord, IntentShares, PositionLifecycleRecord, ResidualOrderRecord, TradeIntent } from "@merkl/protocol-types";
import { decodeSigned, encodeSigned, fieldMerkleRoot, hashFields, recoverSecret, splitSecret } from "@merkl/crypto";
import { BatchMatcherService } from "@/workers/batch-matcher/batch-matcher.service";
import type { MatchResult } from "@/workers/batch-matcher/batch-matcher.model";
import type { ProofCoordinatorService } from "@/workers/proof-coordinator/proof-coordinator.service";
import type {
  CommitteeMatchInput,
  CommitteeSettlementInput,
  CommitteeSettlementTranscript,
  NodeShareSet,
  RecoveredIntent,
  ThresholdShareConfig,
} from "@/workers/threshold-shares/threshold-shares.model";

export class ThresholdShareNodeService {
  readonly nodeId: string;
  private readonly shares = new Map<Hex, IntentShares>();

  constructor(nodeId: string, private readonly sharePath?: string) {
    this.nodeId = nodeId;
    this.load();
  }

  accept(shares: IntentShares): void {
    if (shares.nodeId !== this.nodeId) throw new Error("share node mismatch");
    if (this.shares.has(shares.intentCommitment)) throw new Error("share already stored");
    this.shares.set(shares.intentCommitment, shares);
    this.save();
  }

  get(intentCommitment: Hex): IntentShares | undefined {
    return this.shares.get(intentCommitment);
  }

  private load(): void {
    if (!this.sharePath || !existsSync(this.sharePath)) return;

    const snapshot = JSON.parse(readFileSync(this.sharePath, "utf8"), bigintReviver) as Partial<{
      shares: [Hex, IntentShares][];
    }>;
    this.shares.clear();
    for (const [key, value] of snapshot.shares ?? []) this.shares.set(key, value);
  }

  private save(): void {
    if (!this.sharePath) return;

    mkdirSync(dirname(this.sharePath), { recursive: true });
    const tempPath = `${this.sharePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ shares: [...this.shares.entries()] }, bigintReplacer, 2));
    renameSync(tempPath, this.sharePath);
  }
}

export class ThresholdShareCommittee {
  readonly nodes: ThresholdShareNodeService[];
  readonly threshold: number;
  private readonly matcher = new BatchMatcherService();

  constructor(config: ThresholdShareConfig) {
    if (config.threshold > config.nodeIds.length) {
      throw new Error("threshold cannot exceed node count");
    }
    this.threshold = config.threshold;
    this.nodes = config.nodeIds.map((nodeId) =>
      new ThresholdShareNodeService(
        nodeId,
        config.shareStoreDir ? join(config.shareStoreDir, `${nodeId}.json`) : undefined,
      ),
    );
  }

  shareIntent(intent: TradeIntent, intentCommitment: Hex): NodeShareSet[] {
    const signedSize = intent.side === "long" ? intent.size : -intent.size;
    return this.shareFields({
      intentCommitment,
      limitPrice: intent.limitPrice,
      margin: intent.margin,
      signedSize,
    });
  }

  shareCommitment(domain: "intent-shares" | "residual-shares", intentCommitment: Hex, shareSets: NodeShareSet[]): Hex {
    return hashFields(domain, [
      intentCommitment,
      this.orderedShareSets(intentCommitment, shareSets).map((set) => {
        const share = set.shares[0];
        return [
          set.nodeId,
          share.signedSize.x,
          share.signedSize.y,
          share.limitPrice.x,
          share.limitPrice.y,
          share.margin.x,
          share.margin.y,
        ];
      }),
    ]);
  }

  assertShareSets(intentCommitment: Hex, shareSets: NodeShareSet[]): void {
    this.orderedShareSets(intentCommitment, shareSets);
  }

  shareRecoveredIntent(intent: RecoveredIntent): NodeShareSet[] {
    return this.shareFields(intent);
  }

  private orderedShareSets(intentCommitment: Hex, shareSets: NodeShareSet[]): NodeShareSet[] {
    if (shareSets.length !== this.nodes.length) {
      throw new Error("share set count must equal committee node count");
    }
    if (new Set(shareSets.map((set) => set.nodeId)).size !== shareSets.length) {
      throw new Error("duplicate node share set");
    }

    return this.nodes.map((node, index) => {
      const set = shareSets.find((candidate) => candidate.nodeId === node.nodeId);
      if (!set) throw new Error("missing node share set");
      if (set.shares.length !== 1) throw new Error("node share set must contain one intent share");
      const share = set.shares[0];
      if (share.intentCommitment !== intentCommitment) {
        throw new Error("share intent commitment mismatch");
      }
      if (share.nodeId !== node.nodeId || set.nodeId !== node.nodeId) {
        throw new Error("share node mismatch");
      }
      const expectedX = BigInt(index + 1);
      if (
        share.signedSize.x !== expectedX ||
        share.limitPrice.x !== expectedX ||
        share.margin.x !== expectedX
      ) {
        throw new Error("share x-coordinate mismatch");
      }
      return set;
    });
  }

  private shareFields(input: {
    intentCommitment: Hex;
    limitPrice: bigint;
    margin: bigint;
    signedSize: bigint;
  }): NodeShareSet[] {
    const salts = {
      signedSize: `${input.intentCommitment}:signed-size`,
      limitPrice: `${input.intentCommitment}:limit-price`,
      margin: `${input.intentCommitment}:margin`,
    };

    const signedSizeShares = splitSecret(
      encodeSigned(input.signedSize),
      this.threshold,
      this.nodes.length,
      salts.signedSize,
    );
    const limitPriceShares = splitSecret(
      input.limitPrice,
      this.threshold,
      this.nodes.length,
      salts.limitPrice,
    );
    const marginShares = splitSecret(input.margin, this.threshold, this.nodes.length, salts.margin);

    return this.nodes.map((node, index) => ({
      nodeId: node.nodeId,
      shares: [
        {
          intentCommitment: input.intentCommitment,
          nodeId: node.nodeId,
          signedSize: signedSizeShares[index],
          limitPrice: limitPriceShares[index],
          margin: marginShares[index],
        },
      ],
    }));
  }

  distribute(shareSets: NodeShareSet[]): void {
    for (const set of shareSets) {
      const node = this.nodes.find((candidate) => candidate.nodeId === set.nodeId);
      if (!node) throw new Error("unknown threshold share node");
      for (const shares of set.shares) node.accept(shares);
    }
  }

  matchBatch(input: CommitteeMatchInput): MatchResult {
    const recovered = [
      ...(input.residuals ?? []).map((record) => this.#recoverResidual(record, input.batchId)),
      ...input.records.map((record) => this.#recoverShared(record, record.batchId)),
    ];
    return this.matcher.match({
      batchId: input.batchId,
      market: input.market,
      intents: recovered,
    });
  }

  createSettlementTranscript(
    input: CommitteeSettlementInput,
    proofs: ProofCoordinatorService,
  ): CommitteeSettlementTranscript {
    const match = this.matchBatch(input);
    const newRoot = fieldMerkleRoot([
      ...input.positionCommitments,
      ...match.fills.map((fill) => fill.positionCommitment),
    ]);
    const settlement = proofs.createSettlement({
      batchId: input.batchId,
      market: input.market,
      oldRoot: input.oldRoot,
      newRoot,
      match,
    });

    const positionOpenings = createPositionOpenings(settlement, match.fills);
    return {
      positionEvents: createPositionEvents(match.fills, input.market.fundingIndex),
      positionOpenings,
      residualOrders: this.#createResidualOrderRecords(settlement, match.residuals),
      settlement,
    };
  }

  #recoverShared(
    record: Pick<IntentRecord, "intentCommitment" | "marketId" | "noteNullifier" | "ownerCommitment">,
    batchId: string,
  ): RecoveredIntent {
    const shares = this.nodes
      .map((node) => node.get(record.intentCommitment))
      .filter((value): value is IntentShares => Boolean(value))
      .slice(0, this.threshold);

    if (shares.length < this.threshold) throw new Error("not enough shares to recover intent");

    return {
      intentCommitment: record.intentCommitment,
      batchId,
      marketId: record.marketId,
      ownerCommitment: record.ownerCommitment,
      signedSize: decodeSigned(recoverSecret(shares.map((share) => share.signedSize))),
      limitPrice: recoverSecret(shares.map((share) => share.limitPrice)),
      margin: recoverSecret(shares.map((share) => share.margin)),
      noteNullifier: record.noteNullifier,
    };
  }

  #recoverResidual(record: ResidualOrderRecord, batchId: string): RecoveredIntent {
    return {
      ...this.#recoverShared(record, batchId),
      sourceIntentCommitment: record.sourceIntentCommitment,
    };
  }

  #createResidualOrderRecords(
    settlement: CommitteeSettlementTranscript["settlement"],
    residuals: RecoveredIntent[],
  ): ResidualOrderRecord[] {
    const now = Date.now();
    return residuals.map((residual) => {
      const shareSets = this.shareRecoveredIntent(residual);
      const shareCommitment = this.shareCommitment("residual-shares", residual.intentCommitment, shareSets);
      this.distribute(shareSets);

      return {
        batchId: settlement.batchId,
        createdAt: now,
        intentCommitment: residual.intentCommitment,
        marketId: residual.marketId,
        noteNullifier: residual.noteNullifier,
        ownerCommitment: residual.ownerCommitment,
        shareCommitment,
        sourceIntentCommitment: residual.sourceIntentCommitment ?? residual.intentCommitment,
        updatedAt: now,
      };
    });
  }
}

function createPositionEvents(fills: Array<{
  intentCommitment: Hex;
  marketId: string;
  margin: bigint;
  positionCommitment: Hex;
  positionNullifier: Hex;
  price: bigint;
  side: "long" | "short";
  size: bigint;
}>, fundingIndex: bigint): CommitteeSettlementTranscript["positionEvents"] {
  return fills.map((fill) => ({
    entryPrice: fill.price,
    fundingIndex,
    margin: fill.margin,
    marketId: fill.marketId,
    positionCommitment: fill.positionCommitment,
    positionNullifier: fill.positionNullifier,
    side: fill.side,
    size: fill.size,
    sourceIntentCommitment: fill.intentCommitment,
  }));
}

function createPositionOpenings(
  settlement: CommitteeSettlementTranscript["settlement"],
  fills: Array<{
    intentCommitment: Hex;
    marketId: string;
    ownerCommitment: Hex;
    positionCommitment: Hex;
    positionNullifier: Hex;
  }>,
): PositionLifecycleRecord[] {
  const now = Date.now();
  return fills.map((fill) => ({
    batchId: settlement.batchId,
    marketId: fill.marketId,
    openedAt: now,
    ownerCommitment: fill.ownerCommitment,
    positionCommitment: fill.positionCommitment,
    positionNullifier: fill.positionNullifier,
    settlementDigest: settlement.settlementDigest,
    sourceIntentCommitment: fill.intentCommitment,
    status: "open",
    updatedAt: now,
  }));
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __merklBigInt: value.toString() } : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__merklBigInt" in value &&
    typeof (value as { __merklBigInt: unknown }).__merklBigInt === "string"
  ) {
    return BigInt((value as { __merklBigInt: string }).__merklBigInt);
  }
  return value;
}
