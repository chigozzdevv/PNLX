import { authenticatedAddress } from "@/shared/http/auth-context";
import { json, readJson } from "@/shared/http/json";
import type { MarketsService } from "@/features/markets/markets.service";
import {
  parseMarketCandles,
  parseMarket,
  parseMarketUpdate,
  parseOracleMarket,
  parseOracleRefresh,
} from "@/features/markets/markets.schema";

export class MarketsController {
  constructor(private readonly markets: MarketsService) {}

  async list(): Promise<Response> {
    return json({ markets: await this.markets.list() });
  }

  async ticker(): Promise<Response> {
    return json(await this.markets.ticker());
  }

  async candles(request: Request): Promise<Response> {
    return json(await this.markets.candles(parseMarketCandles(request)));
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
