import { json, readJson } from "@/shared/http/json";
import {
  parseConditionalOrder,
  parseConditionalOrderRegistration,
  parseExecuteConditionalClose,
  parseProvenConditionalOrder,
} from "@/features/conditional-orders/conditional-orders.schema";
import type { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";

export class ConditionalOrdersController {
  constructor(private readonly conditionalOrders: ConditionalOrdersService) {}

  async register(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      { conditionalOrder: this.conditionalOrders.register(parseConditionalOrderRegistration(body)) },
      201,
    );
  }

  async trigger(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ conditionalClose: this.conditionalOrders.trigger(parseConditionalOrder(body)) }, 201);
  }

  async triggerProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      { conditionalClose: this.conditionalOrders.triggerProven(parseProvenConditionalOrder(body)) },
      201,
    );
  }

  async execute(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.conditionalOrders.execute(parseExecuteConditionalClose(body)), 201);
  }
}
