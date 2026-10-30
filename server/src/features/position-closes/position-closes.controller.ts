import { json, readJson } from "@/shared/http/json";
import { authenticatedAddress } from "@/shared/http/auth-context";
import {
  parsePositionClose,
  parsePositionCloseContext,
  parsePositionCloseStatus,
  parseProvenPositionClose,
} from "@/features/position-closes/position-closes.schema";
import type { PositionClosesService } from "@/features/position-closes/position-closes.service";

export class PositionClosesController {
  constructor(private readonly positionCloses: PositionClosesService) {}

  async status(request: Request): Promise<Response> {
    return json({ status: await this.positionCloses.status(
      parsePositionCloseStatus(request), authenticatedAddress(request),
    ) });
  }

  context(request: Request): Response {
    return json({
      context: this.positionCloses.context(
        parsePositionCloseContext(request),
        authenticatedAddress(request),
      ),
    });
  }

  async create(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ positionClose: this.positionCloses.create(parsePositionClose(body)) }, 201);
  }

  async createManual(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ positionClose: await this.positionCloses.createManualPaired(
      parsePositionClose(body), authenticatedAddress(request),
    ) }, 201);
  }

  async createProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json({ positionClose: await this.positionCloses.createProven(
      parseProvenPositionClose(body), authenticatedAddress(request),
    ) }, 201);
  }

  async createManualProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      { positionClose: await this.positionCloses.createManualProven(
        parseProvenPositionClose(body), authenticatedAddress(request),
      ) },
      201,
    );
  }
}
