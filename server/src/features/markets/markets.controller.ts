import { authenticatedAddress } from "../../shared/http/auth-context";
import { json, readJson } from "../../shared/http/json";
import type { MarketsService } from "./markets.service";
import {
  parseMarket,
  parseMarketUpdate,
  parseOracleMarket,
  parseOracleRefresh,
} from "./markets.schema";

export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  list(): Response {
    return json({ markets: this.markets.list() });
  }

  async create(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string | number>>(request);
    return json({ market: this.markets.create(parseMarket(body), authenticatedAddress(request)) }, 201);
  }

  async update(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string | number>>(request);
    return json({ market: this.markets.update(parseMarketUpdate(body), authenticatedAddress(request)) });
  }

  async createFromOracle(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string | number | undefined>>(request);
    return json(
      await this.markets.createFromOracle(parseOracleMarket(body), authenticatedAddress(request)),
      201,
    );
  }

  async refreshFromOracle(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string | number | undefined>>(request);
    return json(
      await this.markets.refreshFromOracle(parseOracleRefresh(body), authenticatedAddress(request)),
    );
  }
}
