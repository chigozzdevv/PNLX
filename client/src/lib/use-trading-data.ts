"use client";

import { useEffect, useMemo, useState } from "react";
import {
  decryptAccountEvent,
  syncPrivateConditionalOrders,
  type PrivateAccountEventPayload,
} from "@/lib/account-encryption";
import { pnlxGet } from "@/lib/pnlx-api";
import { privateSpendableBalance, reconcilePrivateMarginNotes } from "@/lib/private-margin-notes";
import { priceFromOracleString, rateFromMicroBps } from "@/lib/format";
import type {
  AccountSnapshot,
  Hex,
  MarketDisplay,
  ServerAccountEvent,
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
const PRICE_SCALE = 100_000_000;
const SUPPORTED_MARKET_ORDER = ["btc-usd-perp", "eth-usd-perp", "xlm-usd-perp", "sol-usd-perp", "xrp-usd-perp"];
const SUPPORTED_MARKET_IDS = new Set(SUPPORTED_MARKET_ORDER);

export function useTradingData(session: WalletSession | null, refreshKey = 0): TradingDataState {
  const emptyData = useMemo(() => emptyLiveData(session), [session]);
  const [state, setState] = useState<TradingDataState>({
    data: emptyData,
    loading: true,
  });

  useEffect(() => {
    let active = true;

    loadTradingData(session)
      .then((data) => {
        if (!active) return;
        setState({ data, loading: false });
      })
      .catch((error) => {
        if (!active) return;
        setState({
          data: emptyData,
          error: error instanceof Error ? error.message : "Unable to load PNLX trading data",
          loading: false,
        });
      });

    return () => {
      active = false;
    };
  }, [emptyData, refreshKey, session]);

  return state;
}

async function loadTradingData(session: WalletSession | null): Promise<TradingLiveData> {
  const marketsResponse = await pnlxGet<MarketsResponse>("/markets", session?.token);
  const portfolio = session
    ? (await pnlxGet<PortfolioResponse>(
        `/portfolio?ownerCommitment=${encodeURIComponent(session.ownerCommitment)}`,
        session.token,
      )).portfolio
    : undefined;
  const publicMarkets = new Map(
    (portfolio?.publicState.markets ?? []).map((market) => [market.marketId, market]),
  );
  if (session && portfolio) {
    void syncPrivateConditionalOrders(session, portfolio.accountEvents);
    reconcilePrivateMarginNotes({ orders: portfolio.orders });
  }
  const privateOpenings = new Map(
    (session && portfolio ? await decryptPrivateOpenings(session, portfolio.accountEvents) : [])
      .map((payload) => [payload.opening.positionCommitment, payload.opening]),
  );
  const lockedMargin = portfolio?.positions.reduce((total, position) => {
    if (position.status !== "open") return total;
    const opening = privateOpenings.get(position.positionCommitment);
    return total + usdcAmount(opening?.margin);
  }, 0) ?? 0;
  const spendablePrivateMargin = session ? usdcAmount(privateSpendableBalance(session.ownerCommitment).toString()) : 0;
  const markets = canonicalMarkets(marketsResponse.markets).map((market) =>
    marketDisplayFromServer(market, publicMarkets.get(market.marketId)),
  );
  const marketPrices = new Map(markets.map((market) => [market.marketId, market.price]));

  return {
    account: accountFromServer(session, portfolio, lockedMargin, spendablePrivateMargin),
    accountEventCount: portfolio?.accountEvents.length ?? 0,
    activity: portfolio?.activities ?? [],
    markets,
    orders: portfolio?.orders ?? [],
    positions: portfolio?.positions.map((position) => {
      const opening = privateOpenings.get(position.positionCommitment);
      const entryPrice = priceAmount(opening?.entryPrice);
      const size = baseAmount(opening?.size);
      const collateral = usdcAmount(opening?.margin);
      const marketPrice = marketPrices.get(position.marketId);
      const unrealizedPnl = opening && typeof marketPrice === "number" && typeof entryPrice === "number"
        ? (opening.side === "long" ? marketPrice - entryPrice : entryPrice - marketPrice) * size
        : undefined;

      return {
        closePrice: null,
        collateral: collateral || undefined,
        commitment: position.positionCommitment,
        entryPrice,
        id: position.positionCommitment,
        marketId: position.marketId,
        market: pairFromMarketId(position.marketId),
        marketPrice,
        netValue: collateral ? collateral + (unrealizedPnl ?? 0) : undefined,
        privateState: opening
          ? {
              entryPrice: opening.entryPrice,
              fundingIndex: opening.fundingIndex,
              margin: opening.margin,
              positionNullifier: opening.positionNullifier,
              side: opening.side,
              size: opening.size,
              sourceIntentCommitment: opening.sourceIntentCommitment,
            }
          : undefined,
        privateDetails: !opening,
        side: opening?.side,
        size: size || undefined,
        status: position.status,
        time: formatTime(position.openedAt),
        unrealizedPnl,
      };
    }) ?? [],
    ticker: markets.map((market) => ({
      change: market.change24h,
      lastPrice: market.price,
      pair: market.pair,
    })),
  };
}

function canonicalMarkets(markets: ServerMarketConfig[]): ServerMarketConfig[] {
  const byId = new Map<string, ServerMarketConfig>();
  for (const market of markets) {
    if (SUPPORTED_MARKET_IDS.has(market.marketId)) byId.set(market.marketId, market);
  }
  return SUPPORTED_MARKET_ORDER.flatMap((marketId) => {
    const market = byId.get(marketId);
    return market ? [market] : [];
  });
}

function emptyLiveData(session: WalletSession | null): TradingLiveData {
  return {
    account: accountFromServer(session, undefined),
    accountEventCount: 0,
    activity: [],
    markets: [],
    orders: [],
    positions: [],
    ticker: [],
  };
}

function accountFromServer(
  session: WalletSession | null,
  portfolio: ServerPortfolioSnapshot | undefined,
  lockedMargin = 0,
  spendablePrivateMargin = 0,
): AccountSnapshot {
  const privateTotal = lockedMargin + spendablePrivateMargin;
  return {
    address: session?.address ?? "",
    accountValue: privateTotal > 0 ? privateTotal : null,
    availableShieldedUsdc: spendablePrivateMargin > 0 ? spendablePrivateMargin : null,
    cash: spendablePrivateMargin > 0 ? spendablePrivateMargin : null,
    lockedMargin,
    livePnl: 0,
    marginRoot: portfolio?.publicState.marginRoot ?? portfolio?.publicState.marginMembershipRoot ?? ZERO_ROOT,
    privacyMode: "shielded",
    shieldedUsdc: privateTotal > 0 ? privateTotal : null,
  };
}

async function decryptPrivateOpenings(
  session: WalletSession,
  accountEvents: ServerAccountEvent[],
): Promise<Array<Extract<PrivateAccountEventPayload, { kind: "position-opening" }>>> {
  const payloads = await Promise.all(
    accountEvents.map((event) =>
      decryptAccountEvent<PrivateAccountEventPayload>(
        session.ownerCommitment,
        event.ciphertext,
      ).catch(() => undefined)
    ),
  );

  return payloads.filter(
    (payload): payload is Extract<PrivateAccountEventPayload, { kind: "position-opening" }> =>
      payload?.kind === "position-opening",
  );
}

function usdcAmount(value: string | undefined): number {
  if (!value) return 0;
  const amount = Number(BigInt(value));
  return Number.isFinite(amount) ? amount : 0;
}

function priceAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return Number(BigInt(value)) / PRICE_SCALE;
}

function baseAmount(value: string | undefined): number {
  if (!value) return 0;
  const amount = Number(BigInt(value));
  return Number.isFinite(amount) ? amount : 0;
}

function marketDisplayFromServer(
  market: ServerMarketConfig,
  publicMarket: ServerMarketPublicSnapshot | undefined,
): MarketDisplay {
  const baseAsset = baseAssetFromMarketId(market.marketId);
  const price = priceFromOracleString(market.oraclePrice);
  const aggregateVolume = publicMarket ? Number(BigInt(publicMarket.aggregateVolume)) : 0;
  const grossOpenInterest = publicMarket ? Number(BigInt(publicMarket.grossOpenInterest)) : 0;
  const pending = publicMarket?.pendingIntentCount ?? 0;

  return {
    assetName: titleFromBaseAsset(baseAsset),
    baseAsset,
    change24h: 0,
    fundingIndex: market.fundingIndex,
    initialMarginRate: rateFromMicroBps(market.initialMarginRate),
    maintenanceMarginRate: rateFromMicroBps(market.maintenanceMarginRate),
    marketId: market.marketId,
    maxLeverage: Number(BigInt(market.maxLeverage)),
    netRateLong: 0,
    netRateShort: 0,
    openInterestLong: grossOpenInterest / 2,
    openInterestShort: grossOpenInterest / 2,
    oraclePrice: market.oraclePrice,
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
