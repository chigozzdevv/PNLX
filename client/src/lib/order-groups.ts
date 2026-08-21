import type { ServerOwnerOrderSnapshot } from "@/types/trading";

export interface OwnerOrderGroup {
  activeOrders: ServerOwnerOrderSnapshot[];
  createdAt: number;
  id: string;
  isResidual: boolean;
  marketId: string;
  matching: ServerOwnerOrderSnapshot["matching"];
  orders: ServerOwnerOrderSnapshot[];
  status: ServerOwnerOrderSnapshot["status"];
  updatedAt: number;
}

export function logicalOrderId(order: ServerOwnerOrderSnapshot): string {
  const fragment = /^(ui-\d+-.+)-(\d+)$/.exec(order.batchId);
  return fragment?.[1] ?? order.intentCommitment;
}

export function groupOwnerOrders(orders: ServerOwnerOrderSnapshot[]): OwnerOrderGroup[] {
  const grouped = new Map<string, ServerOwnerOrderSnapshot[]>();
  for (const order of orders) {
    const id = logicalOrderId(order);
    grouped.set(id, [...(grouped.get(id) ?? []), order]);
  }

  return [...grouped.entries()]
    .map(([id, fragments]) => createOrderGroup(id, fragments))
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function isActiveOrder(order: ServerOwnerOrderSnapshot): boolean {
  return order.status === "open" || order.status === "partially-filled";
}

export function isActiveOrderGroup(group: OwnerOrderGroup): boolean {
  return group.activeOrders.length > 0;
}

function createOrderGroup(id: string, input: ServerOwnerOrderSnapshot[]): OwnerOrderGroup {
  const orders = [...input].sort((left, right) => {
    const leftIndex = fragmentIndex(left.batchId);
    const rightIndex = fragmentIndex(right.batchId);
    return leftIndex === rightIndex ? left.createdAt - right.createdAt : leftIndex - rightIndex;
  });
  const activeOrders = orders.filter(isActiveOrder);
  const matchingOrder = [...(activeOrders.length > 0 ? activeOrders : orders)]
    .sort((left, right) => matchingTimestamp(right) - matchingTimestamp(left))[0];

  return {
    activeOrders,
    createdAt: Math.min(...orders.map((order) => order.createdAt)),
    id,
    isResidual: orders.some((order) => order.isResidual),
    marketId: orders[0].marketId,
    matching: matchingOrder.matching,
    orders,
    status: groupStatus(orders, activeOrders),
    updatedAt: Math.max(...orders.map((order) => order.updatedAt)),
  };
}

function groupStatus(
  orders: ServerOwnerOrderSnapshot[],
  activeOrders: ServerOwnerOrderSnapshot[],
): ServerOwnerOrderSnapshot["status"] {
  if (activeOrders.length > 0) {
    const hasResolvedFragment = orders.some((order) => !isActiveOrder(order));
    const hasPartialFragment = activeOrders.some((order) => order.status === "partially-filled");
    return hasResolvedFragment || hasPartialFragment ? "partially-filled" : "open";
  }
  if (orders.every((order) => order.status === "cancelled")) return "cancelled";
  if (orders.every((order) => order.status === "filled")) return "filled";
  return "partially-filled";
}

function fragmentIndex(batchId: string): number {
  const match = /^ui-\d+-.+-(\d+)$/.exec(batchId);
  return match ? Number(match[1]) : 1;
}

function matchingTimestamp(order: ServerOwnerOrderSnapshot): number {
  return order.matching.completedAt ?? order.updatedAt;
}
