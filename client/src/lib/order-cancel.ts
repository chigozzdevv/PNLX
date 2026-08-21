import { pnlxPost } from "@/lib/pnlx-api";
import type { OwnerOrderGroup } from "@/lib/order-groups";
import type { Hex, ServerOwnerOrderSnapshot } from "@/types/trading";

interface CancelOrderResponse {
  order: ServerOwnerOrderSnapshot;
}

export async function cancelOrder(input: {
  intentCommitment: Hex;
  token?: string;
}): Promise<ServerOwnerOrderSnapshot> {
  const response = await pnlxPost<CancelOrderResponse>(
    "/orders/cancel",
    { intentCommitment: input.intentCommitment },
    input.token,
  );
  return response.order;
}

export async function cancelOrderGroup(input: {
  group: OwnerOrderGroup;
  token?: string;
}): Promise<{
  cancelled: ServerOwnerOrderSnapshot[];
  error?: Error;
}> {
  const cancelled: ServerOwnerOrderSnapshot[] = [];
  for (const order of input.group.activeOrders) {
    try {
      cancelled.push(await cancelOrder({
        intentCommitment: order.intentCommitment,
        token: input.token,
      }));
    } catch (error) {
      return {
        cancelled,
        error: new Error(
          cancelled.length === 0
            ? (error instanceof Error ? error.message : "Order cancel failed")
            : `Cancelled ${cancelled.length} of ${input.group.activeOrders.length} private balance inputs. Refresh Orders to review the remainder.`,
          { cause: error },
        ),
      };
    }
  }
  return { cancelled };
}
