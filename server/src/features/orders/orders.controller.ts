import { authenticatedAddress } from "@/shared/http/auth-context";
import { json, readJson } from "@/shared/http/json";
import { parseCancelOrder, parseClaimResidual, parseReplaceOrder } from "@/features/orders/orders.schema";
import type { OrdersService } from "@/features/orders/orders.service";

export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  async cancel(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.orders.cancel(parseCancelOrder(body), authenticatedAddress(request)));
  }

  async claimResidual(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.orders.claimResidual(parseClaimResidual(body), authenticatedAddress(request)));
  }

  async residualClaim(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.orders.residualClaim(parseCancelOrder(body), authenticatedAddress(request)));
  }

  async replace(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      this.orders.replace(parseReplaceOrder(body), authenticatedAddress(request)),
      201,
    );
  }
}
