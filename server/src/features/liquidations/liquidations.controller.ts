import { json, readJson } from "@/shared/http/json";
import { parseLiquidation, parseProvenLiquidation } from "@/features/liquidations/liquidations.schema";
import type { LiquidationsService } from "@/features/liquidations/liquidations.service";

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
