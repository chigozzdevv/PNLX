import type { ServerEnv } from "../../config/env";
import type { MarketConfig } from "@merkl/protocol-types";
import { RATE_SCALE } from "@merkl/market-math";
import { SUPPORTED_PERP_ASSETS } from "../../config/assets";
import { assertProtocolAdmin } from "../../shared/http/auth-context";
import {
  assertOracleAuthorityReady,
  assertOracleReadyForOnchain,
} from "../../shared/protocol/oracle-readiness";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type { OnchainMarketConfig, OraclePriceRelayInput } from "../../workers/onchain/onchain.model";
import type { OnchainRelayService } from "../../workers/onchain/onchain.service";
import type { OracleService } from "../../workers/oracle/oracle.service";
import type {
  CreateOracleMarketInput,
  RefreshOracleMarketInput,
  UpdateMarketInput,
} from "./markets.model";

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

  list(): MarketConfig[] {
    return [...this.executor.store.markets.values()];
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
