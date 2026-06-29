import { authenticatedAddress } from "../../shared/http/auth-context";
import { json, readJson } from "../../shared/http/json";
import { parseAccountKey, parseAccountKeyQuery } from "./account-keys.schema";
import type { AccountKeysService } from "./account-keys.service";

export class AccountKeysController {
  constructor(private readonly accountKeys: AccountKeysService) {}

  async upsert(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      { accountKey: this.accountKeys.upsert(parseAccountKey(body), authenticatedAddress(request)) },
      201,
    );
  }

  get(request: Request): Response {
    return json({
      accountKey: this.accountKeys.get(parseAccountKeyQuery(request), authenticatedAddress(request)),
    });
  }
}
