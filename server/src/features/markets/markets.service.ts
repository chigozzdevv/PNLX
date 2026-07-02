import type { ServerEnv } from "@/config/env";
import type { MarketConfig } from "@pnlx/protocol-types";
import { PRICE_SCALE, RATE_SCALE } from "@pnlx/market-math";
import { SUPPORTED_PERP_ASSETS } from "@/config/assets";
import { assertProtocolAdmin } from "@/shared/http/auth-context";
import {
  assertOracleAuthorityReady,
  assertOracleReadyForOnchain,
} from "@/shared/protocol/oracle";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainMarketConfig, OraclePriceRelayInput } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { OracleService } from "@/workers/oracle/oracle.service";
import type {
  CreateOracleMarketInput,
  MarketCandle,
  MarketCandlesInput,
  MarketCandleInterval,
  MarketTickerItem,
  RefreshOracleMarketInput,
  UpdateMarketInput,
} from "@/features/markets/markets.model";

export interface OracleMarketResult {
  market: MarketConfig;
  onchain?: {
    market?: unknown;
    oracle?: unknown;
  };
  oracle: {
    confidence: bigint;
    confidenceBps: bigint;
    feedId: string;
    price: bigint;
    publishTime: number;
    source?: string;
  };
}

export class MarketsService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly oracle: OracleService,
    private readonly env: ServerEnv,
    private readonly onchain?: OnchainRelayService,
  ) {}

  create(input: MarketConfig, authenticated?: string): MarketConfig {
    assertProtocolAdmin(authenticated, this.env.protocolAdminAddresses, {
      required: this.env.protocolAdminRequired,
    });
    assertValidMarketConfig(input);
    this.assertNewMarket(input.marketId);
    if (this.onchainEnabled()) {
      this.onchain?.upsertMarket(input, marketRelayConfig(input.marketId, this.env));
    }
    this.executor.addMarket(input);
    return input;
  }

  async createFromOracle(
    input: CreateOracleMarketInput,
    authenticated?: string,
  ): Promise<OracleMarketResult> {
    assertProtocolAdmin(authenticated, this.env.protocolAdminAddresses, {
      required: this.env.protocolAdminRequired,
    });
    assertOracleAuthorityReady(this.env);
    if (this.onchainEnabled()) assertOracleReadyForOnchain(this.env);
    const price = await this.oracle.latestMarket({
      feedId: feedIdForMarket(input.marketId, this.env, input.feedId),
      marketId: input.marketId,
    });
    const market = {
      marketId: input.marketId,
      oraclePrice: price.price,
      maxLeverage: input.maxLeverage,
      initialMarginRate: input.initialMarginRate,
      maintenanceMarginRate: input.maintenanceMarginRate,
      fundingIndex: input.fundingIndex,
    };

    assertValidMarketConfig(market);
    this.assertNewMarket(market.marketId);
    const oracleRelay = this.onchainEnabled() && shouldPublishOracle(this.env)
      ? this.onchain?.publishOraclePrice(
          oracleRelayConfig(market.marketId, this.env, price.price, price.publishTime),
        )
      : undefined;
    const marketRelay = this.onchainEnabled()
      ? this.onchain?.upsertMarket(market, marketRelayConfig(market.marketId, this.env))
      : undefined;
    this.executor.addMarket(market);
    return {
      market,
      onchain: oracleRelay || marketRelay ? { market: marketRelay, oracle: oracleRelay } : undefined,
      oracle: price,
    };
  }

  update(input: UpdateMarketInput, authenticated?: string): MarketConfig {
    assertProtocolAdmin(authenticated, this.env.protocolAdminAddresses, {
      required: this.env.protocolAdminRequired,
    });
    assertValidMarketConfig(input);
    if (!this.executor.store.markets.has(input.marketId)) {
      throw new Error("unknown market");
    }
    if (this.onchainEnabled()) {
      this.onchain?.upsertMarket(input, marketRelayConfig(input.marketId, this.env));
    }
    this.executor.store.updateMarket(input);
    return input;
  }

  async refreshFromOracle(
    input: RefreshOracleMarketInput,
    authenticated?: string,
  ): Promise<OracleMarketResult> {
    assertProtocolAdmin(authenticated, this.env.protocolAdminAddresses, {
      required: this.env.protocolAdminRequired,
    });
    assertOracleAuthorityReady(this.env);
    if (this.onchainEnabled()) assertOracleReadyForOnchain(this.env);
    const existing = this.executor.store.markets.get(input.marketId);
    if (!existing) throw new Error("unknown market");

    const price = await this.oracle.latestMarket({
      feedId: feedIdForMarket(input.marketId, this.env, input.feedId),
      marketId: input.marketId,
    });
    const market = {
      ...existing,
      oraclePrice: price.price,
    };
    assertValidMarketConfig(market);
    const oracleRelay = this.onchainEnabled() && shouldPublishOracle(this.env)
      ? this.onchain?.publishOraclePrice(
          oracleRelayConfig(market.marketId, this.env, price.price, price.publishTime),
        )
      : undefined;
    this.executor.store.updateMarket(market);
    return {
      market,
      onchain: oracleRelay ? { oracle: oracleRelay } : undefined,
      oracle: price,
    };
  }

  async list(): Promise<MarketConfig[]> {
    await this.ensureSupportedMarkets();
    return canonicalMarkets(this.executor.store.markets.values());
  }

  async ticker() {
    return {
      fetchedAt: Date.now(),
      source: "hyperliquid",
      ticker: await hyperliquidTicker(),
    };
  }

  async candles(input: MarketCandlesInput) {
    const asset = supportedAssetForMarket(input.marketId);
    if (HYPERLIQUID_CANDLE_ASSETS.has(asset.symbol)) {
      return hyperliquidCandles(input, asset.symbol);
    }

    return pythBenchmarkCandles(input, asset.symbol);
  }

  private assertNewMarket(marketId: string): void {
    if (this.executor.store.markets.has(marketId)) {
      throw new Error("market already exists");
    }
  }

  private onchainEnabled(): boolean {
    return Boolean(
      this.onchain && ((this.onchain as { enabled?: boolean }).enabled ?? true),
    );
  }

  private async ensureSupportedMarkets(): Promise<void> {
    let tickerFallback: Map<string, MarketTickerItem> | undefined;
    for (const asset of Object.values(SUPPORTED_PERP_ASSETS)) {
      const existing = this.executor.store.markets.get(asset.marketId);
      try {
        const oraclePrice = await this.bootstrapMarketPrice(asset.marketId, async () => {
          tickerFallback ??= new Map((await hyperliquidTicker()).map((item) => [item.marketId, item]));
          return tickerFallback.get(asset.marketId);
        });
        this.upsertSupportedMarket(asset, oraclePrice, existing?.fundingIndex ?? 0n);
      } catch {
        if (existing) {
          this.upsertSupportedMarket(asset, existing.oraclePrice, existing.fundingIndex);
        }
      }
    }
  }

  private upsertSupportedMarket(
    asset: (typeof SUPPORTED_PERP_ASSETS)[keyof typeof SUPPORTED_PERP_ASSETS],
    oraclePrice: bigint,
    fundingIndex: bigint,
  ): void {
    const market = {
      fundingIndex,
      initialMarginRate: asset.initialMarginRate,
      maintenanceMarginRate: asset.maintenanceMarginRate,
      marketId: asset.marketId,
      maxLeverage: asset.maxLeverage,
      oraclePrice,
    };

    if (this.executor.store.markets.has(asset.marketId)) {
      this.executor.store.updateMarket(market);
    } else {
      this.executor.addMarket(market);
    }
  }

  private async bootstrapMarketPrice(
    marketId: string,
    fallback: () => Promise<MarketTickerItem | undefined>,
  ): Promise<bigint> {
    try {
      const price = await this.oracle.latestMarket({
        feedId: feedIdForMarket(marketId, this.env),
        marketId,
      });
      return price.price;
    } catch {
      const ticker = await fallback();
      if (!ticker) throw new Error(`missing bootstrap price for ${marketId}`);
      return BigInt(Math.round(ticker.price * Number(PRICE_SCALE)));
    }
  }
}

function canonicalMarkets(markets: Iterable<MarketConfig>): MarketConfig[] {
  const byId = new Map([...markets].map((market) => [market.marketId, market]));
  return Object.values(SUPPORTED_PERP_ASSETS).flatMap((asset) => {
    const market = byId.get(asset.marketId);
    return market ? [market] : [];
  });
}

const HYPERLIQUID_CANDLE_ASSETS = new Set(["BTC", "ETH", "SOL", "XLM", "XRP"]);
const HYPERLIQUID_TICKER_SYMBOLS = [
  "XLM",
  "BTC",
  "BNB",
  "SOL",
  "ETH",
  "XRP",
  "ADA",
  "DOGE",
  "AVAX",
  "LINK",
  "LTC",
  "ATOM",
];

async function hyperliquidTicker(): Promise<MarketTickerItem[]> {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "pnlx-hyperliquid-ticker/0.1",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`ticker provider failed with ${response.status}`);
  }

  const payload = await response.json();
  return parseHyperliquidTicker(payload);
}

async function hyperliquidCandles(input: MarketCandlesInput, coin: string) {
  const granularity = intervalSeconds(input.interval);
  const endTime = Date.now();
  const startTime = endTime - granularity * input.limit * 1000;

  const response = await fetch("https://api.hyperliquid.xyz/info", {
    body: JSON.stringify({
      req: {
        coin,
        endTime,
        interval: input.interval,
        startTime,
      },
      type: "candleSnapshot",
    }),
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "pnlx-hyperliquid-candles/0.1",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`candle provider failed with ${response.status}`);
  }

  const payload = await response.json();
  const candles = parseHyperliquidCandles(payload).slice(-input.limit);

  return {
    candles,
    fetchedAt: Date.now(),
    interval: input.interval,
    marketId: input.marketId,
    productId: coin,
    realtime: input.interval === "1m",
    source: "hyperliquid",
  };
}

async function pythBenchmarkCandles(input: MarketCandlesInput, symbol: string) {
  const benchmarkSymbol = `Crypto.${symbol}/USD`;
  const granularity = intervalSeconds(input.interval);
  const to = Math.floor(Date.now() / 1000);
  const from = to - granularity * input.limit;
  const url = new URL("https://benchmarks.pyth.network/v1/shims/tradingview/history");
  url.searchParams.set("symbol", benchmarkSymbol);
  url.searchParams.set("resolution", pythResolution(input.interval));
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "pnlx-pyth-candles/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`candle provider failed with ${response.status}`);
  }

  const payload = await response.json();
  const candles = parsePythTradingViewCandles(payload).slice(-input.limit);

  return {
    candles,
    fetchedAt: Date.now(),
    interval: input.interval,
    marketId: input.marketId,
    productId: benchmarkSymbol,
    realtime: input.interval === "1m",
    source: "pyth-benchmarks",
  };
}

function supportedAssetForMarket(marketId: string) {
  const asset = Object.values(SUPPORTED_PERP_ASSETS).find((candidate) => candidate.marketId === marketId);
  if (!asset) throw new Error(`unsupported candle market ${marketId}`);
  return asset;
}

function intervalSeconds(interval: MarketCandleInterval): number {
  const seconds: Record<MarketCandleInterval, number> = {
    "1d": 86_400,
    "1h": 3_600,
    "1m": 60,
    "5m": 300,
    "15m": 900,
  };
  return seconds[interval];
}

function pythResolution(interval: MarketCandleInterval): string {
  if (interval === "1d") return "D";
  return String(intervalSeconds(interval) / 60);
}

function parsePythTradingViewCandles(payload: unknown): MarketCandle[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid candle provider response");
  }
  const response = payload as Record<string, unknown>;
  if (response.s !== "ok") {
    throw new Error(typeof response.errmsg === "string" ? response.errmsg : "candle provider returned no data");
  }

  const times = numberArray(response.t, "time");
  const opens = numberArray(response.o, "open");
  const highs = numberArray(response.h, "high");
  const lows = numberArray(response.l, "low");
  const closes = numberArray(response.c, "close");
  const volumes = Array.isArray(response.v) ? numberArray(response.v, "volume") : [];
  const count = Math.min(times.length, opens.length, highs.length, lows.length, closes.length);
  if (count === 0) {
    throw new Error("candle provider returned no candles");
  }

  const candles: MarketCandle[] = [];
  for (let index = 0; index < count; index += 1) {
    candles.push({
      close: closes[index],
      high: highs[index],
      low: lows[index],
      open: opens[index],
      time: new Date(times[index] * 1000).toISOString(),
      volume: volumes[index] ?? 0,
    });
  }
  return candles;
}

function parseHyperliquidCandles(payload: unknown): MarketCandle[] {
  if (!Array.isArray(payload)) {
    throw new Error("invalid candle provider response");
  }
  if (payload.length === 0) {
    throw new Error("candle provider returned no candles");
  }

  return payload
    .map((item) => {
      if (!item || typeof item !== "object") {
        throw new Error("invalid candle provider row");
      }
      const row = item as Record<string, unknown>;
      return {
        close: finiteNumber(row.c, "close"),
        high: finiteNumber(row.h, "high"),
        low: finiteNumber(row.l, "low"),
        open: finiteNumber(row.o, "open"),
        time: new Date(finiteNumber(row.t, "time")).toISOString(),
        volume: finiteNumber(row.v, "volume"),
      };
    })
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
}

function parseHyperliquidTicker(payload: unknown): MarketTickerItem[] {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new Error("invalid ticker provider response");
  }
  const meta = payload[0] as Record<string, unknown>;
  const contexts = payload[1];
  if (!Array.isArray(meta.universe) || !Array.isArray(contexts)) {
    throw new Error("invalid ticker provider market list");
  }

  const bySymbol = new Map<string, Record<string, unknown>>();
  meta.universe.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const name = (item as Record<string, unknown>).name;
    const context = contexts[index];
    if (typeof name === "string" && context && typeof context === "object") {
      bySymbol.set(name, context as Record<string, unknown>);
    }
  });

  return HYPERLIQUID_TICKER_SYMBOLS.flatMap((symbol) => {
    const context = bySymbol.get(symbol);
    if (!context) return [];
    const price = firstFiniteNumber([context.markPx, context.midPx, context.oraclePx], "price");
    const previous = finiteNumber(context.prevDayPx, "previous price");
    const change24h = previous > 0 ? ((price - previous) / previous) * 100 : 0;
    const configured = SUPPORTED_PERP_ASSETS[symbol];

    return [{
      change24h,
      marketId: configured?.marketId ?? `${symbol.toLowerCase()}-usd-perp`,
      openInterest: finiteNumber(context.openInterest ?? 0, "open interest"),
      pair: configured?.displaySymbol ?? `${symbol}/USD`,
      price,
      source: "hyperliquid",
      volume24h: finiteNumber(context.dayNtlVlm ?? 0, "24h volume"),
    }];
  });
}

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`missing candle ${label}`);
  return value.map((item) => finiteNumber(item, label));
}

function firstFiniteNumber(values: unknown[], label: string): number {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  throw new Error(`invalid ticker ${label}`);
}

function finiteNumber(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid candle ${label}`);
  return number;
}

function assertValidMarketConfig(market: MarketConfig): void {
  if (!market.marketId.trim()) throw new Error("market id is required");
  if (market.oraclePrice <= 0n) throw new Error("oracle price must be positive");
  if (market.maxLeverage <= 0n) throw new Error("max leverage must be positive");
  if (market.initialMarginRate <= 0n) throw new Error("initial margin rate must be positive");
  if (market.maintenanceMarginRate <= 0n) throw new Error("maintenance margin rate must be positive");
  if (market.initialMarginRate > RATE_SCALE) throw new Error("initial margin rate too high");
  if (market.maintenanceMarginRate > RATE_SCALE) throw new Error("maintenance margin rate too high");
  if (market.maintenanceMarginRate > market.initialMarginRate) {
    throw new Error("maintenance margin rate exceeds initial margin rate");
  }
  if (market.fundingIndex < 0n) throw new Error("funding index cannot be negative");
}

function feedIdForMarket(
  marketId: string,
  env: ServerEnv,
  override?: `0x${string}`,
): `0x${string}` {
  if (override) return override;
  const asset = Object.values(SUPPORTED_PERP_ASSETS).find((candidate) => candidate.marketId === marketId);
  const configured = asset ? env.pythFeedIds?.[asset.symbol] : undefined;
  const feedId = configured ?? asset?.pythFeedId ?? env.pythBtcUsdFeedId;
  return feedId.startsWith("0x") ? (feedId as `0x${string}`) : (`0x${feedId}` as const);
}

function marketRelayConfig(marketId: string, env: ServerEnv): OnchainMarketConfig {
  const asset = Object.values(SUPPORTED_PERP_ASSETS).find((candidate) => candidate.marketId === marketId);
  return {
    oracleAssetAddress: asset?.oracleAssetAddress || env.oracleAssetAddress,
    oracleAssetSymbol: asset?.oracleAssetSymbol || env.oracleAssetSymbol,
    oracleAssetType: asset?.oracleAssetType || (env.oracleAssetType === "stellar" ? "stellar" : "other"),
    oracleBeamFeeToken: env.oracleBeamFeeToken,
    oracleContractId: env.oracleContractId,
    oracleKind: env.oracleKind,
    oracleMaxAge: env.oraclePriceMaxAgeSeconds,
    oracleTwapRecords: env.oracleTwapRecords,
    priceDecimals: env.oraclePriceDecimals,
  };
}

function oracleRelayConfig(
  marketId: string,
  env: ServerEnv,
  price: bigint,
  publishTime: number,
): OraclePriceRelayInput {
  const asset = Object.values(SUPPORTED_PERP_ASSETS).find((candidate) => candidate.marketId === marketId);
  const assetType = asset?.oracleAssetType || (env.oracleAssetType === "stellar" ? "stellar" : "other");
  const mode = publishMode(env.oraclePublishMode);
  return {
    assetAddress: asset?.oracleAssetAddress || env.oracleAssetAddress,
    assetSymbol: asset?.oracleAssetSymbol || env.oracleAssetSymbol,
    assetType,
    oracleContractId: env.oracleContractId,
    price,
    publishMode: mode,
    publishers: mode === "committee" ? oraclePublishers(env) : [],
    round: String(Date.now()),
    timestamp: publishTime,
  };
}

function publishMode(value: string): "admin" | "committee" {
  if (value === "admin" || value === "committee") return value;
  throw new Error("invalid oracle publish mode");
}

function shouldPublishOracle(env: ServerEnv): boolean {
  return env.oraclePriceSource !== "onchain-market";
}

function oraclePublishers(env: ServerEnv): OraclePriceRelayInput["publishers"] {
  if (env.oracleCommitteeThreshold < 2) {
    throw new Error("oracle committee threshold must be at least 2");
  }
  if (env.oraclePublisherAddresses.length < env.oracleCommitteeThreshold) {
    throw new Error("missing oracle publisher addresses");
  }
  const sources = env.oraclePublisherSources.length > 0 ? env.oraclePublisherSources : [env.stellarSource];
  if (sources.length < env.oraclePublisherAddresses.length) {
    throw new Error("missing oracle publisher sources");
  }
  return sources.map((source, index) => {
    const address = env.oraclePublisherAddresses[index] || (/^G[A-Z0-9]{55}$/.test(source) ? source : "");
    if (!address) {
      throw new Error("missing oracle publisher address");
    }
    return {
      address,
      source,
    };
  });
}
