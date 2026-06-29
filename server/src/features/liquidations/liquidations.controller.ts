import { json, readJson } from "../../shared/http/json";
import { parseLiquidation, parseProvenLiquidation } from "./liquidations.schema";
import type { LiquidationsService } from "./liquidations.service";

export class LiquidationsController {
  constructor(private readonly liquidations: LiquidationsService) {}

  async create(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ liquidation: this.liquidations.create(parseLiquidation(body)) }, 201);
  }

  async createProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ liquidation: this.liquidations.createProven(parseProvenLiquidation(body)) }, 201);
  }
}
