import { json, readJson } from "@/shared/http/json";
import { authenticatedAddress } from "@/shared/http/auth-context";
import type { RelaysService } from "@/features/relays/relays.service";
import { parseRelay, parseSignedXdr } from "@/features/relays/relays.schema";

export class RelaysController {
  constructor(private readonly relays: RelaysService) {}

  list(): Response {
    return json({ relays: this.relays.list() });
  }

  async create(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ relay: this.relays.create(parseRelay(body), authenticatedAddress(request)) }, 201);
  }

  async submitSignedXdr(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      { relay: this.relays.submitSignedXdr(parseSignedXdr(body), authenticatedAddress(request)) },
      201,
    );
  }
}
