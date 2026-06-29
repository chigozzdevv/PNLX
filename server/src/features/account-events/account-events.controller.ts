import { authenticatedAddress } from "../../shared/http/auth-context";
import { json, readJson } from "../../shared/http/json";
import type { AccountEventsService } from "./account-events.service";
import { parseAccountEvent, parseAccountEventList } from "./account-events.schema";

export class AccountEventsController {
  constructor(private readonly accountEvents: AccountEventsService) {}

  async create(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      { accountEvent: this.accountEvents.create(parseAccountEvent(body), authenticatedAddress(request)) },
      201,
    );
  }

  list(request: Request): Response {
    return json({
      accountEvents: this.accountEvents.list(parseAccountEventList(request), authenticatedAddress(request)),
    });
  }
}
