import { authenticatedAddress } from "../../shared/http/auth-context";
import { json, readJson } from "../../shared/http/json";
import { parseCancelOrder, parseReplaceOrder } from "./orders.schema";
import type { OrdersService } from "./orders.service";

export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  async cancel(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.orders.cancel(parseCancelOrder(body), authenticatedAddress(request)));
  }

  async replace(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      this.orders.replace(parseReplaceOrder(body), authenticatedAddress(request)),
      201,
    );
  }
}
