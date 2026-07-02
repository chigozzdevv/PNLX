import {
  circuitPositionCommitment,
  circuitPositionNullifier,
  commitMargin,
  digestToFieldHex,
  hashFields,
} from "@pnlx/crypto";
import { hasInitialMargin, hasMaxLeverage } from "@pnlx/market-math";
import type { Fill, Hex, MarginNote, PositionNote } from "@pnlx/protocol-types";
import type { MatchExecution, MatchInput, MatchResult } from "@/workers/batch-matcher/batch-matcher.model";
import { matchTranscriptDigest } from "@/workers/batch-matcher/match-transcript";
import type { RecoveredIntent } from "@/workers/threshold-shares/threshold-shares.model";

interface BookOrder {
  allocatedMargin: bigint;
  filled: bigint;
  intent: RecoveredIntent;
  remaining: bigint;
  sequence: number;
  side: "long" | "short";
  size: bigint;
}

export class BatchMatcherService {
  match(input: MatchInput): MatchResult {
    const orders = input.intents.map((intent, sequence) => toBookOrder(intent, sequence));
    rejectDuplicateNullifiers(orders);
    const longs = orders
      .filter((order) => order.side === "long")
      .sort((a, b) => compareLongPriority(a, b));
    const shorts = orders
      .filter((order) => order.side === "short")
      .sort((a, b) => compareShortPriority(a, b));

    const fills: Fill[] = [];
    const executions: MatchExecution[] = [];
    const spentNullifiers = new Set<Hex>();
    let longIndex = 0;
    let shortIndex = 0;

    while (longIndex < longs.length && shortIndex < shorts.length) {
      const long = longs[longIndex];
      const short = shorts[shortIndex];

      if (long.intent.limitPrice < short.intent.limitPrice) {
        break;
      }

      const size = min(long.remaining, short.remaining);
      const price = executionPrice(long, short);
      const longFill = createFill(input, long, size, price, fills.length);
      const shortFill = createFill(input, short, size, price, fills.length + 1);
      const execution = createExecution(long, short, size, price, longFill, shortFill);

      fills.push(longFill, shortFill);
      executions.push(execution);
      spentNullifiers.add(long.intent.noteNullifier);
      spentNullifiers.add(short.intent.noteNullifier);

      long.remaining -= size;
      short.remaining -= size;
      if (long.remaining === 0n) longIndex += 1;
      if (short.remaining === 0n) shortIndex += 1;
    }

    if (fills.length === 0) {
      throw new Error("batch has no crossed liquidity");
    }

    const aggregateVolume = fills.reduce((sum, fill) => sum + fill.size, 0n);
    const totalLongSize = orders
      .filter((order) => order.side === "long")
      .reduce((sum, order) => sum + order.size, 0n);
    const totalShortSize = orders
      .filter((order) => order.side === "short")
      .reduce((sum, order) => sum + order.size, 0n);
    const inputSigned = totalLongSize - totalShortSize;
    const filledSigned = fills.reduce(
      (sum, fill) => sum + (fill.side === "long" ? fill.size : -fill.size),
      0n,
    );
    const residualSigned = inputSigned - filledSigned;

    const match = {
      executions,
      fills,
      marginChangeCommitments: createMarginChangeCommitments(orders),
      orderUpdates: createOrderUpdates(orders),
      residuals: createResiduals(input, orders),
      spentNullifiers: [...spentNullifiers],
      aggregateVolume,
      openInterestDelta: aggregateVolume,
      residualSize: residualSigned < 0n ? -residualSigned : residualSigned,
      totalLongSize,
      totalShortSize,
    };

    return {
      ...match,
      matchTranscriptDigest: matchTranscriptDigest(match),
    };
  }
}

function createOrderUpdates(orders: BookOrder[]) {
  return orders
    .filter((order) => order.filled > 0n)
    .map((order) => ({
      intentCommitment: order.intent.intentCommitment,
      residualCommitment: order.remaining > 0n ? residualCommitment(order) : undefined,
      status: order.remaining > 0n ? "partially-filled" as const : "filled" as const,
    }));
}

function createResiduals(input: MatchInput, orders: BookOrder[]): RecoveredIntent[] {
  return orders
    .filter((order) => order.filled > 0n && order.remaining > 0n)
    .map((order) => {
      const margin = order.intent.margin - order.allocatedMargin;
      if (margin <= 0n) throw new Error("invalid residual margin");
      return {
        batchId: input.batchId,
        intentCommitment: residualCommitment(order),
        limitPrice: order.intent.limitPrice,
        margin,
        marketId: order.intent.marketId,
        noteNullifier: residualNullifier(order),
        ownerCommitment: order.intent.ownerCommitment,
        signedSize: order.side === "long" ? order.remaining : -order.remaining,
        sourceIntentCommitment: order.intent.intentCommitment,
      };
    });
}

function toBookOrder(intent: RecoveredIntent, sequence: number): BookOrder {
  const side = intent.signedSize >= 0n ? "long" : "short";
  const size = intent.signedSize >= 0n ? intent.signedSize : -intent.signedSize;

  if (size === 0n) throw new Error("intent size cannot be zero");
  if (intent.limitPrice <= 0n) throw new Error("intent limit price must be positive");
  if (intent.margin <= 0n) throw new Error("intent margin must be positive");

  return {
    allocatedMargin: 0n,
    filled: 0n,
    intent,
    remaining: size,
    sequence,
    side,
    size,
  };
}

function compareLongPriority(a: BookOrder, b: BookOrder): number {
  if (a.intent.limitPrice !== b.intent.limitPrice) {
    return a.intent.limitPrice > b.intent.limitPrice ? -1 : 1;
  }
  return a.sequence - b.sequence;
}

function compareShortPriority(a: BookOrder, b: BookOrder): number {
  if (a.intent.limitPrice !== b.intent.limitPrice) {
    return a.intent.limitPrice < b.intent.limitPrice ? -1 : 1;
  }
  return a.sequence - b.sequence;
}

function executionPrice(long: BookOrder, short: BookOrder): bigint {
  const maker = long.sequence <= short.sequence ? long : short;
  return maker.intent.limitPrice;
}

function createExecution(
  long: BookOrder,
  short: BookOrder,
  size: bigint,
  price: bigint,
  longFill: Fill,
  shortFill: Fill,
): MatchExecution {
  const maker = long.sequence <= short.sequence ? long : short;
  const taker = maker === long ? short : long;
  return {
    longIntentCommitment: long.intent.intentCommitment,
    longLimitPrice: long.intent.limitPrice,
    longNoteNullifier: long.intent.noteNullifier,
    longPositionCommitment: longFill.positionCommitment,
    makerIntentCommitment: maker.intent.intentCommitment,
    makerSide: maker.side,
    price,
    shortIntentCommitment: short.intent.intentCommitment,
    shortLimitPrice: short.intent.limitPrice,
    shortNoteNullifier: short.intent.noteNullifier,
    shortPositionCommitment: shortFill.positionCommitment,
    size,
    takerIntentCommitment: taker.intent.intentCommitment,
  };
}

function createFill(input: MatchInput, order: BookOrder, size: bigint, price: bigint, fillIndex: number): Fill {
  const margin = allocateMargin(order, size);
  if (!hasInitialMargin(size, price, margin, input.market.initialMarginRate)) {
    throw new Error("insufficient initial margin");
  }
  if (!hasMaxLeverage(size, price, margin, input.market.maxLeverage)) {
    throw new Error("max leverage exceeded");
  }

  const position: PositionNote = {
    marketId: order.intent.marketId,
    side: order.side,
    size,
    entryPrice: price,
    margin,
    fundingIndex: input.market.fundingIndex,
    owner: order.intent.ownerCommitment,
    rho: `${order.intent.intentCommitment}:position:${fillIndex}`,
    blinding: `${order.intent.intentCommitment}:blinding:${fillIndex}`,
  };
  const marketDigest = digestToFieldHex(`market:${position.marketId}`);
  const ownerDigest = digestToFieldHex(`owner:${position.owner}`);
  const rhoDigest = digestToFieldHex(`rho:${position.rho}`);
  const blinding = digestToFieldHex(`blinding:${position.blinding}`);
  const spendSecretDigest = digestToFieldHex(`spend:${position.owner}:${position.rho}`);
  const positionCommitment = circuitPositionCommitment({
    blinding,
    entryPrice: position.entryPrice,
    fundingIndex: position.fundingIndex,
    margin: position.margin,
    marketDigest,
    ownerDigest,
    rhoDigest,
    side: position.side,
    size: position.size,
    spendSecretDigest,
  });
  const positionNullifier = circuitPositionNullifier({ rhoDigest, spendSecretDigest });

  return {
    intentCommitment: order.intent.intentCommitment,
    marketId: order.intent.marketId,
    ownerCommitment: order.intent.ownerCommitment,
    side: order.side,
    size,
    price,
    margin,
    positionCommitment,
    positionNullifier,
  };
}

function allocateMargin(order: BookOrder, fillSize: bigint): bigint {
  const nextFilled = order.filled + fillSize;
  const nextAllocatedMargin = ceilDiv(order.intent.margin * nextFilled, order.size);
  const fillMargin = nextAllocatedMargin - order.allocatedMargin;
  order.filled = nextFilled;
  order.allocatedMargin = nextAllocatedMargin;
  return fillMargin;
}

function createMarginChangeCommitments(orders: BookOrder[]): Hex[] {
  return orders
    .filter((order) => order.filled > 0n && order.remaining > 0n)
    .map((order) => {
      const remainingMargin = order.intent.margin - order.allocatedMargin;
      if (remainingMargin <= 0n) throw new Error("invalid margin change");
      const note: MarginNote = {
        assetId: "usdc",
        amount: remainingMargin,
        owner: order.intent.ownerCommitment,
        rho: `${order.intent.intentCommitment}:margin-change:${order.filled}`,
        blinding: `${order.intent.intentCommitment}:margin-change-blinding:${order.remaining}`,
      };
      return commitMargin(note);
    });
}

function residualCommitment(order: BookOrder): Hex {
  return hashFields("residual-order", [
    order.intent.intentCommitment,
    order.filled,
    order.allocatedMargin,
  ]);
}

function residualNullifier(order: BookOrder): Hex {
  return hashFields("residual-nullifier", [
    order.intent.intentCommitment,
    order.filled,
    order.remaining,
    order.allocatedMargin,
  ]);
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function rejectDuplicateNullifiers(orders: BookOrder[]): void {
  const seen = new Set<Hex>();
  for (const order of orders) {
    if (seen.has(order.intent.noteNullifier)) {
      throw new Error("duplicate intent nullifier");
    }
    seen.add(order.intent.noteNullifier);
  }
}
