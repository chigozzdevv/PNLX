import { logicalOrderId } from "@/lib/order-groups";
import type { PositionRow, ServerOwnerOrderSnapshot, Side } from "@/types/trading";

/**
 * A single user order can be matched by multiple maker notes. The protocol
 * keeps one position commitment per fill, but the UI should present those
 * fills as one logical position.
 */
export function groupPositionRows(
  positions: readonly PositionRow[],
  orders: readonly ServerOwnerOrderSnapshot[] = [],
): PositionRow[] {
  const orderIndex = indexOrders(orders);
  const grouped = new Map<string, { id: string; stable: boolean; legs: PositionRow[] }>();
  const seen = new Set<string>();
  for (const position of positions.flatMap(positionLegs)) {
    const positionId = normalizedCommitment(position.commitment) ?? normalizedCommitment(position.id) ?? position.id;
    if (seen.has(positionId)) continue;
    seen.add(positionId);
    const source = normalizedCommitment(position.sourceIntentCommitment);
    const privateSource = position.privateState && normalizedCommitment(position.privateState.sourceIntentCommitment);
    const inconsistentPrivateState = position.privateState && (privateSource !== source ||
      (position.side !== undefined && position.privateState.side !== position.side));
    const sourceOrder = source && !inconsistentPrivateState ? originalOrder(source, position.marketId, orderIndex) : null;
    const logicalId = sourceOrder ? normalizedCommitment(logicalOrderId(sourceOrder)) ?? logicalOrderId(sourceOrder) : sourceOrder;
    const side = position.side === "long" || position.side === "short" ? position.side : undefined;
    // Without a trustworthy source, retain separate protocol rows. Unknown order
    // history still supports the previous same-intent grouping behavior.
    const identity = !source || logicalId === null
      ? ["position", positionId]
      : [logicalId && side ? "order" : "intent", logicalId && side ? logicalId : source, position.marketId, side ?? "unknown"];
    const key = JSON.stringify(identity);
    const group = grouped.get(key) ?? {
      id: logicalId && side
        ? `position-group:${logicalId}:${position.marketId}:${side}`
        : `position-group:${source}:${position.marketId}:${side ?? "unknown"}`,
      stable: Boolean(logicalId && side),
      legs: [],
    };
    group.legs.push(position);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((group) => createPositionGroup(group.legs, group.id, group.stable))
    .sort((left, right) => right.openedAt - left.openedAt || left.id.localeCompare(right.id));
}

function normalizedCommitment(value: string | undefined): string | undefined {
  return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? value.toLowerCase() : undefined;
}

function indexOrders(orders: readonly ServerOwnerOrderSnapshot[]): Map<string, ServerOwnerOrderSnapshot | null> {
  const index = new Map<string, ServerOwnerOrderSnapshot | null>();
  const fragments = new Map<string, Set<string>>();
  for (const order of orders) {
    const id = normalizedCommitment(order.intentCommitment);
    if (!id) continue;
    const previous = index.get(id);
    if (previous === null) continue;
    if (previous && (previous.batchId !== order.batchId || previous.marketId !== order.marketId ||
        previous.isResidual !== order.isResidual ||
        normalizedCommitment(previous.sourceIntentCommitment) !== normalizedCommitment(order.sourceIntentCommitment) ||
        normalizedCommitment(previous.matchingPayloadCommitment) !== normalizedCommitment(order.matchingPayloadCommitment))) {
      index.set(id, null);
    } else index.set(id, order);
    if (!order.isResidual && logicalOrderId(order) !== order.intentCommitment) {
      const key = JSON.stringify([order.marketId, order.batchId]);
      const ids = fragments.get(key) ?? new Set<string>();
      ids.add(id);
      fragments.set(key, ids);
    }
  }
  for (const ids of fragments.values()) {
    if (ids.size > 1) for (const id of ids) index.set(id, null);
  }
  return index;
}

/** Undefined means legacy history is absent; null means supplied history is unsafe. */
function originalOrder(
  source: string,
  marketId: string,
  orders: Map<string, ServerOwnerOrderSnapshot | null>,
): ServerOwnerOrderSnapshot | undefined | null {
  if (!orders.has(source)) return undefined;
  const visited = new Set<string>();
  let current = source;
  while (!visited.has(current)) {
    visited.add(current);
    const order = orders.get(current);
    if (!order || order.marketId !== marketId) return null;
    if (!order.isResidual) return order;
    const parent = normalizedCommitment(order.sourceIntentCommitment);
    if (!parent) return null;
    current = parent;
  }
  return null;
}

/** Resolve a fill's original submitted order without trusting execution batch IDs. */
export function positionSourceOrder(
  position: Pick<PositionRow, "sourceIntentCommitment" | "marketId">,
  orders: readonly ServerOwnerOrderSnapshot[],
): ServerOwnerOrderSnapshot | undefined {
  const source = normalizedCommitment(position.sourceIntentCommitment);
  return source ? originalOrder(source, position.marketId, indexOrders(orders)) ?? undefined : undefined;
}

/** Return the protocol legs represented by a UI position row. */
export function positionLegs(position: PositionRow): PositionRow[] {
  return position.positionLegs ?? [position];
}

export function hasPrivatePositionState(position: PositionRow): boolean {
  return Boolean(position.privateState) || Boolean(position.positionLegs?.length &&
    position.positionLegs.every((leg) => Boolean(leg.privateState)));
}

function createPositionGroup(input: PositionRow[], id: string, stable: boolean): PositionRow {
  const legs = [...input].sort(
    (left, right) => left.openedAt - right.openedAt || left.id.localeCompare(right.id),
  );
  if (legs.length === 1 && !stable) return legs[0];

  const first = legs[0];
  const fullyPrivate = legs.every((leg) => Boolean(leg.privateState) && !leg.privateDetails);
  const size = fullyPrivate ? sumKnown(legs.map((leg) => leg.size)) : undefined;
  const collateral = fullyPrivate ? sumKnown(legs.map((leg) => leg.collateral)) : undefined;
  const entryFee = fullyPrivate ? sumKnown(legs.map((leg) => leg.entryFee ?? 0)) : undefined;
  const unrealizedPnl = fullyPrivate ? sumKnown(legs.map((leg) => leg.unrealizedPnl)) : undefined;
  const netValue = fullyPrivate ? sumKnown(legs.map((leg) => leg.netValue)) : undefined;
  const entryPrice = fullyPrivate ? weightedAverage(legs.map((leg) => ({
    price: leg.entryPrice,
    size: leg.size,
  }))) : undefined;
  const side = commonSide(legs);
  const marketPrice = legs.every((leg) => Number.isFinite(leg.marketPrice) && leg.marketPrice === first.marketPrice)
    ? first.marketPrice : undefined;

  return {
    ...first,
    closePrice: null,
    collateral,
    entryFee,
    commitment: undefined,
    entryPrice,
    id,
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
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) return undefined;
  const total = (values as number[]).reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : undefined;
}

function weightedAverage(values: Array<{ price?: number; size?: number }>): number | undefined {
  if (values.some((value) => typeof value.price !== "number" || !Number.isFinite(value.price) || value.price <= 0 ||
      typeof value.size !== "number" || !Number.isFinite(value.size) || value.size <= 0)) {
    return undefined;
  }
  const totalSize = values.reduce((total, value) => total + (value.size ?? 0), 0);
  if (!Number.isFinite(totalSize) || totalSize <= 0) return undefined;
  const average = values.reduce((total, value) => total + (value.price ?? 0) * (value.size ?? 0), 0) / totalSize;
  return Number.isFinite(average) ? average : undefined;
}
