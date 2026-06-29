"use client";

import { useEffect, useMemo, useState } from "react";
import { mockTradingData } from "@/data/mock-trading-data";
import { syncPrivateConditionalOrders } from "@/lib/account-encryption";
import { merklGet } from "@/lib/merkl-api";
import { priceFromOracleString, rateFromMicroBps } from "@/lib/format";
import type {
  AccountSnapshot,
  Hex,
  MarketDisplay,
  ServerMarketConfig,
  ServerMarketPublicSnapshot,
  ServerPortfolioSnapshot,
  TradingLiveData,
} from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

interface MarketsResponse {
  markets: ServerMarketConfig[];
}

interface PortfolioResponse {
  portfolio: ServerPortfolioSnapshot;
}

interface TradingDataState {
  data: TradingLiveData;
  error?: string;
  loading: boolean;
}

const ZERO_ROOT = `0x${"0".repeat(64)}` as Hex;

export function useTradingData(session: WalletSession | null, refreshKey = 0): TradingDataState {
  const fallback = useMemo(() => mockLiveData(session), [session]);
  const [state, setState] = useState<TradingDataState>({
    data: fallback,
    loading: true,
  });

  useEffect(() => {
    let active = true;

    loadTradingData(session, fallback)
      .then((data) => {
        if (!active) return;
        setState({ data, loading: false });
      })
      .catch((error) => {
        if (!active) return;
        setState({
          data: fallback,
          error: error instanceof Error ? error.message : "Unable to load Merkl trading data",
          loading: false,
        });
      });

    return () => {
      active = false;
    };
  }, [fallback, refreshKey, session]);

  return state;
}

async function loadTradingData(
  session: WalletSession | null,
  fallback: TradingLiveData,
): Promise<TradingLiveData> {
  const marketsResponse = await merklGet<MarketsResponse>("/markets", session?.token);
  const portfolio = session
    ? (await merklGet<PortfolioResponse>(
        `/portfolio?ownerCommitment=${encodeURIComponent(session.ownerCommitment)}`,
        session.token,
      )).portfolio
    : undefined;
  const publicMarkets = new Map(
    (portfolio?.publicState.markets ?? []).map((market) => [market.marketId, market]),
  );
  if (session && portfolio) {
    void syncPrivateConditionalOrders(session, portfolio.accountEvents);
  }
  const markets = marketsResponse.markets.map((market) =>
    marketDisplayFromServer(market, publicMarkets.get(market.marketId), fallback),
  );

  return {
    account: accountFromServer(session, portfolio, fallback.account),
    accountEventCount: portfolio?.accountEvents.length ?? 0,
    activity: portfolio?.activities ?? [],
    markets,
    orders: portfolio?.orders ?? [],
    positions: portfolio?.positions.map((position) => ({
      closePrice: null,
      commitment: position.positionCommitment,
      id: position.positionCommitment,
      market: pairFromMarketId(position.marketId),
      privateDetails: true,
      status: position.status,
      time: formatTime(position.openedAt),
    })) ?? [],
    ticker: markets.map((market) => ({
      change: market.change24h,
      pair: market.pair,
    })),
  };
}

function mockLiveData(session: WalletSession | null): TradingLiveData {
  return {
    account: {
      ...mockTradingData.account,
      address: session?.address ?? mockTradingData.account.address,
      marginRoot: mockTradingData.server.deposit.note.marginRoot,
    },
    accountEventCount: 0,
    activity: [],
    markets: mockTradingData.markets,
    orders: [],
    positions: mockTradingData.positions,
    ticker: mockTradingData.ticker,
  };
}

function accountFromServer(
  session: WalletSession | null,
  portfolio: ServerPortfolioSnapshot | undefined,
  fallback: AccountSnapshot,
): AccountSnapshot {
  return {
    address: session?.address ?? fallback.address,
    accountValue: 0,
    cash: 0,
    livePnl: 0,
    marginRoot: portfolio?.publicState.marginRoot ?? portfolio?.publicState.marginMembershipRoot ?? ZERO_ROOT,
    privacyMode: "shielded",
  };
}

function marketDisplayFromServer(
  market: ServerMarketConfig,
  publicMarket: ServerMarketPublicSnapshot | undefined,
  fallback: TradingLiveData,
): MarketDisplay {
  const fallbackMarket = fallback.markets.find((candidate) => candidate.marketId === market.marketId);
  const price = priceFromOracleString(market.oraclePrice);
  const aggregateVolume = publicMarket ? Number(BigInt(publicMarket.aggregateVolume)) : 0;
  const grossOpenInterest = publicMarket ? Number(BigInt(publicMarket.grossOpenInterest)) : 0;
  const pending = publicMarket?.pendingIntentCount ?? 0;

  return {
    assetName: fallbackMarket?.assetName ?? titleFromBaseAsset(baseAssetFromMarketId(market.marketId)),
    baseAsset: baseAssetFromMarketId(market.marketId),
    change24h: fallbackMarket?.change24h ?? 0,
    fundingIndex: market.fundingIndex,
    initialMarginRate: rateFromMicroBps(market.initialMarginRate),
    maintenanceMarginRate: rateFromMicroBps(market.maintenanceMarginRate),
    marketId: market.marketId,
    maxLeverage: Number(BigInt(market.maxLeverage)),
    netRateLong: fallbackMarket?.netRateLong ?? 0,
    netRateShort: fallbackMarket?.netRateShort ?? 0,
    openInterestLong: grossOpenInterest / 2,
    openInterestShort: grossOpenInterest / 2,
    pair: pairFromMarketId(market.marketId),
    price,
    quoteAsset: "USD",
    status: pending > 0 ? "settling" : "live",
    volume24h: aggregateVolume,
  };
}

function pairFromMarketId(marketId: string): string {
  return `${baseAssetFromMarketId(marketId)}/USD`;
}

function baseAssetFromMarketId(marketId: string): string {
  return marketId.split("-")[0]?.toUpperCase() || "PERP";
}

function titleFromBaseAsset(asset: string): string {
  const names: Record<string, string> = {
    BTC: "Bitcoin",
    ETH: "Ethereum",
    SOL: "Solana",
    XLM: "Stellar",
    XRP: "XRP",
  };
  return names[asset] ?? asset;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
