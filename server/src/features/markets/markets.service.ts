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
import { MarketDataService } from "@/features/markets/market-data.service";
import type {
  CreateOracleMarketInput,
  MarketCandlesInput,
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
  private readonly marketData: MarketDataService;

  constructor(
    private readonly executor: ExecutorService,
    private readonly oracle: OracleService,
    private readonly env: ServerEnv,
    private readonly onchain?: OnchainRelayService,
    marketData?: MarketDataService,
  ) {
    this.marketData = marketData ?? new MarketDataService(env);
  }

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
      ? await publishOraclePrice(
          this.onchain,
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
      ? await publishOraclePrice(
          this.onchain,
          oracleRelayConfig(market.marketId, this.env, price.price, price.publishTime),
        )
      : undefined;
    const marketRepairRelay = this.onchain as
      | Partial<Pick<OnchainRelayService, "isMarketActive" | "upsertMarket">>
      | undefined;
    const shouldRepairMarket = this.onchainEnabled() &&
      marketRepairRelay?.isMarketActive?.(market.marketId) === false;
    const marketRelay = shouldRepairMarket
      ? marketRepairRelay?.upsertMarket?.(market, marketRelayConfig(market.marketId, this.env))
      : undefined;
    this.executor.store.updateMarket(market);
    return {
      market,
      onchain: oracleRelay || marketRelay ? { market: marketRelay, oracle: oracleRelay } : undefined,
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
    return this.marketData.candles(input);
  }

  priceStream(marketId: string, signal?: AbortSignal): Response {
    return this.marketData.stream(marketId, signal);
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
    const supportedAssets = Object.values(SUPPORTED_PERP_ASSETS);
    const hasAllSupportedMarkets = supportedAssets.every((asset) =>
      this.executor.store.markets.has(asset.marketId)
    );
    if (hasAllSupportedMarkets) return;

    let tickerFallback: Map<string, MarketTickerItem> | undefined;
    for (const asset of supportedAssets) {
      const existing = this.executor.store.markets.get(asset.marketId);
      if (existing) continue;
      try {
        const oraclePrice = await this.bootstrapMarketPrice(asset.marketId, async () => {
          tickerFallback ??= new Map((await hyperliquidTicker()).map((item) => [item.marketId, item]));
          return tickerFallback.get(asset.marketId);
        });
        this.upsertSupportedMarket(asset, oraclePrice, 0n);
      } catch {
        continue;
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
    const fundingRate = optionalFiniteNumber(context.funding);

    return [{
      change24h,
      fundingRate: fundingRate === null ? null : fundingRate * 100,
      marketId: configured?.marketId ?? `${symbol.toLowerCase()}-usd-perp`,
      openInterest: finiteNumber(context.openInterest ?? 0, "open interest"),
      pair: configured?.displaySymbol ?? `${symbol}/USD`,
      price,
      source: "hyperliquid",
      volume24h: finiteNumber(context.dayNtlVlm ?? 0, "24h volume"),
    }];
  });
}

function optionalFiniteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

async function publishOraclePrice(
  onchain: OnchainRelayService | undefined,
  input: OraclePriceRelayInput,
) {
  if (!onchain) return undefined;
  return onchain.publishOraclePriceAsync
    ? onchain.publishOraclePriceAsync(input)
    : onchain.publishOraclePrice(input);
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
