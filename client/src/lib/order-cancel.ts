import { pnlxPost } from "@/lib/pnlx-api";
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
