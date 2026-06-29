import { json, readJson } from "../../shared/http/json";
import { authenticatedAddress } from "../../shared/http/auth-context";
import type { IntentsService } from "./intents.service";
import { parseIntent, parseProveAndSubmitIntent, parseSharedIntent } from "./intents.schema";

export class IntentsController {
  constructor(private readonly intents: IntentsService) {}

  async create(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.intents.submit(parseIntent(body), authenticatedAddress(request)), 201);
  }

  async createShared(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.intents.submitShared(parseSharedIntent(body), authenticatedAddress(request)), 201);
  }

  async proveAndSubmit(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.intents.proveAndSubmit(parseProveAndSubmitIntent(body), authenticatedAddress(request)), 201);
  }
}
