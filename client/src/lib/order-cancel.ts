import { pnlxPost } from "@/lib/pnlx-api";
import type { OwnerOrderGroup } from "@/lib/order-groups";
import type { Hex, ServerOwnerOrderSnapshot } from "@/types/trading";

interface CancelOrderResponse {
  order: Pick<ServerOwnerOrderSnapshot, "intentCommitment">;
}

export interface CancelledOrder {
  intentCommitment: Hex;
  noteNullifier?: Hex;
  sourceIntentCommitment?: Hex;
}

export async function cancelOrder(input: {
  intentCommitment: Hex;
  token?: string;
}): Promise<CancelledOrder> {
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
  cancelled: CancelledOrder[];
  error?: Error;
}> {
  const cancelled: CancelledOrder[] = [];
  for (const order of input.group.activeOrders) {
    try {
      const response = await cancelOrder({
        intentCommitment: order.intentCommitment,
        token: input.token,
      });
      if (response.intentCommitment.toLowerCase() !== order.intentCommitment.toLowerCase()) {
        throw new Error("Cancellation returned a different private order");
      }
      // Preserve the loaded residual source link as the relay response only
      // contains the lifecycle record and does not include residual metadata.
      cancelled.push({
        intentCommitment: order.intentCommitment,
        noteNullifier: order.noteNullifier,
        sourceIntentCommitment: order.sourceIntentCommitment,
      });
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
