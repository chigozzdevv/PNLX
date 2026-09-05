import type { PositionRow, Side } from "@/types/trading";

/**
 * A single user order can be matched by multiple maker notes. The protocol
 * keeps one position commitment per fill, but the UI should present those
 * fills as one logical position.
 */
export function groupPositionRows(positions: PositionRow[]): PositionRow[] {
  const grouped = new Map<string, PositionRow[]>();
  for (const position of positions) {
    const key = `${position.sourceIntentCommitment}:${position.marketId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), position]);
  }

  return [...grouped.values()]
    .map((legs) => createPositionGroup(legs))
    .sort((left, right) => right.openedAt - left.openedAt || left.id.localeCompare(right.id));
}

/** Return the protocol legs represented by a UI position row. */
export function positionLegs(position: PositionRow): PositionRow[] {
  return position.positionLegs ?? [position];
}

export function hasPrivatePositionState(position: PositionRow): boolean {
  return Boolean(position.privateState) || Boolean(position.positionLegs?.every((leg) => Boolean(leg.privateState)));
}

function createPositionGroup(input: PositionRow[]): PositionRow {
  const legs = [...input].sort(
    (left, right) => left.openedAt - right.openedAt || left.id.localeCompare(right.id),
  );
  if (legs.length === 1) return legs[0];

  const first = legs[0];
  const fullyPrivate = legs.every((leg) => Boolean(leg.privateState) && !leg.privateDetails);
  const sizes = fullyPrivate ? legs.map((leg) => leg.size) : [];
  const size = sumKnown(sizes);
  const collateral = fullyPrivate ? sumKnown(legs.map((leg) => leg.collateral)) : undefined;
  const unrealizedPnl = fullyPrivate ? sumKnown(legs.map((leg) => leg.unrealizedPnl)) : undefined;
  const netValue = fullyPrivate ? sumKnown(legs.map((leg) => leg.netValue)) : undefined;
  const entryPrice = fullyPrivate ? weightedAverage(legs.map((leg) => ({
    price: leg.entryPrice,
    size: leg.size,
  }))) : undefined;
  const side = commonSide(legs);
  const marketPrice = legs.find((leg) => typeof leg.marketPrice === "number")?.marketPrice;

  return {
    ...first,
    closePrice: null,
    collateral,
    commitment: undefined,
    entryPrice,
    id: `position-group:${first.sourceIntentCommitment}`,
    marketPrice,
    netValue,
    openedAt: Math.min(...legs.map((leg) => leg.openedAt)),
    positionLegs: legs,
    privateDetails: !fullyPrivate,
    privateState: undefined,
    side,
    size,
    unrealizedPnl,
  };
}

function commonSide(positions: PositionRow[]): Side | undefined {
  const side = positions[0]?.side;
  return side && positions.every((position) => position.side === side) ? side : undefined;
}

function sumKnown(values: Array<number | undefined>): number | undefined {
  if (values.some((value) => typeof value !== "number")) return undefined;
  return (values as number[]).reduce((total, value) => total + value, 0);
}

function weightedAverage(values: Array<{ price?: number; size?: number }>): number | undefined {
  if (values.some((value) => typeof value.price !== "number" || typeof value.size !== "number")) {
    return undefined;
  }
  const totalSize = values.reduce((total, value) => total + (value.size ?? 0), 0);
  if (totalSize <= 0) return undefined;
  return values.reduce((total, value) => total + (value.price ?? 0) * (value.size ?? 0), 0) / totalSize;
}
