"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  decryptAccountEvent,
  ensureAccountEncryptionKey,
  recoverAccountEncryptionKey,
  syncPrivateConditionalOrders,
  type PrivateAccountEventPayload,
} from "@/lib/account-encryption";
import { protocolBaseToDisplay, protocolUsdcToDisplay } from "@/lib/asset-units";
import { apiPath } from "@/lib/api-path";
import { pnlxGet } from "@/lib/pnlx-api";
import { backUpPrivateOpening, restorePrivateOpenings } from "@/lib/private-note-backup";
import { setPrivateNoteBackupWarning } from "@/lib/wallet-auth";
import {
  privatePendingBalance,
  privateReservedBalance,
  privateSpendableBalance,
  privateMarginNoteRuntimeScopeFromHealth,
  reconcilePrivateMarginNotes,
  type ReconciledPrivateMarginOrder,
  setPrivateMarginNoteRuntimeScope,
} from "@/lib/private-margin-notes";
import { priceFromOracleString, rateFromMicroBps } from "@/lib/format";
import { walletMatchedVolumeUsd } from "@/lib/wallet-volume";
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

interface HealthResponse {
  custody?: {
    collateralAsset?: {
      tokenContract?: string;
      tokenDigest?: Hex;
    };
  };
  persistence?: {
    mongodb?: {
      collection?: string;
      database?: string;
    };
  };
  runtime?: {
    clientStorageScope?: string;
  };
  stellar?: {
    network?: string;
  };
}

interface TradingDataState {
  data: TradingLiveData;
  error?: string;
  loading: boolean;
}

const ZERO_ROOT = `0x${"0".repeat(64)}` as Hex;
const PRICE_SCALE = 100_000_000;
const ONCHAIN_MARK_MAX_SILENCE_MS = 10_000;
const PRIVATE_OPENING_RECOVERY_PREFIX = "pnlx.account-key-opening-recovery.v2";
const SUPPORTED_MARKET_ORDER = ["btc-usd-perp", "eth-usd-perp", "xlm-usd-perp", "sol-usd-perp", "xrp-usd-perp"];
const SUPPORTED_MARKET_IDS = new Set(SUPPORTED_MARKET_ORDER);

export function useTradingData(session: WalletSession | null, refreshKey = 0): TradingDataState {
  const emptyData = useMemo(() => emptyLiveData(session), [session]);
  const [privateNotesVersion, setPrivateNotesVersion] = useState(0);
  const latestOnchainMarks = useRef(new Map<string, { price?: bigint; receivedAt: number }>());
  const [state, setState] = useState<TradingDataState>({
    data: emptyData,
    loading: true,
  });

  useEffect(() => {
    function refreshPrivateNotes() {
      setPrivateNotesVersion((value) => value + 1);
    }

    window.addEventListener("pnlx:private-margin-notes", refreshPrivateNotes);
    window.addEventListener("storage", refreshPrivateNotes);
    return () => {
      window.removeEventListener("pnlx:private-margin-notes", refreshPrivateNotes);
      window.removeEventListener("storage", refreshPrivateNotes);
    };
  }, []);

  useEffect(() => {
    let active = true;

    loadTradingData(session)
      .then((data) => {
        if (!active) return;
        setState({ data: applyLatestOnchainMarks(data, latestOnchainMarks.current), loading: false });
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
  }, [emptyData, privateNotesVersion, refreshKey, session]);

  const markMarketKey = useMemo(
    () => [...new Set(
      state.data.positions
        .filter((position) => position.status === "open")
        .map((position) => position.marketId),
    )].sort().join("|"),
    [state.data.positions],
  );

  useEffect(() => {
    function clearOnchainMark(marketId: string) {
      latestOnchainMarks.current.set(marketId, { receivedAt: Date.now() });
      setState((current) => {
        let changed = false;
        const positions = current.data.positions.map((position) => {
          if (
            position.status !== "open" ||
            position.marketId !== marketId ||
            (position.marketPrice === undefined && position.unrealizedPnl === undefined)
          ) return position;
          changed = true;
          return { ...position, marketPrice: undefined, unrealizedPnl: undefined };
        });
        return changed ? { ...current, data: { ...current.data, positions } } : current;
      });
    }

    if (!markMarketKey || typeof EventSource === "undefined") return;
    const sources = markMarketKey.split("|").map((marketId) => {
      const source = new EventSource(
        `${apiPath("markets/marks/stream")}?marketId=${encodeURIComponent(marketId)}`,
      );
      source.addEventListener("mark", (event) => {
        if (!(event instanceof MessageEvent)) return;
        try {
          const update = JSON.parse(event.data) as {
            marketId: string;
            price: string;
            publishedAt: number;
            source: string;
          };
          if (
            update.marketId !== marketId ||
            update.source !== "onchain-market" ||
            !/^\d+$/.test(update.price) ||
            !Number.isSafeInteger(update.publishedAt) ||
            update.publishedAt <= 0
          ) return;
          const rawMarkPrice = BigInt(update.price);
          if (rawMarkPrice <= 0n) return;
          latestOnchainMarks.current.set(marketId, { price: rawMarkPrice, receivedAt: Date.now() });
          const marketPrice = Number(rawMarkPrice) / PRICE_SCALE;
          setState((current) => {
            let changed = false;
            const positions = current.data.positions.map((position) => {
              if (position.status !== "open" || position.marketId !== marketId) return position;
              const unrealizedPnl = unrealizedPnlAtMark(position, rawMarkPrice);
              if (position.marketPrice === marketPrice && position.unrealizedPnl === unrealizedPnl) {
                return position;
              }
              changed = true;
              return {
                ...position,
                marketPrice,
                unrealizedPnl,
              };
            });
            return changed
              ? { ...current, data: { ...current.data, positions } }
              : current;
          });
        } catch {
          // Ignore malformed mark updates and keep the last verified value.
        }
      });
      source.addEventListener("unavailable", (event) => {
        if (!(event instanceof MessageEvent)) return;
        try {
          const update = JSON.parse(event.data) as { marketId: string; source: string };
          if (update.marketId !== marketId || update.source !== "onchain-market") return;
          clearOnchainMark(marketId);
        } catch {
          // Ignore malformed mark status updates.
        }
      });
      source.onerror = () => clearOnchainMark(marketId);
      return source;
    });
    const freshnessTimer = window.setInterval(() => {
      const now = Date.now();
      for (const [marketId, mark] of latestOnchainMarks.current) {
        if (mark.price && now - mark.receivedAt > ONCHAIN_MARK_MAX_SILENCE_MS) {
          clearOnchainMark(marketId);
        }
      }
    }, 2_000);

    return () => {
      window.clearInterval(freshnessTimer);
      sources.forEach((source) => source.close());
    };
  }, [markMarketKey]);

  return state;
}

function applyLatestOnchainMarks(
  data: TradingLiveData,
  marks: Map<string, { price?: bigint; receivedAt: number }>,
): TradingLiveData {
  let changed = false;
  const positions = data.positions.map((position) => {
    if (position.status !== "open") return position;
    const mark = marks.get(position.marketId);
    if (!mark) return position;
    if (!mark.price || Date.now() - mark.receivedAt > ONCHAIN_MARK_MAX_SILENCE_MS) {
      if (position.marketPrice === undefined && position.unrealizedPnl === undefined) return position;
      changed = true;
      return { ...position, marketPrice: undefined, unrealizedPnl: undefined };
    }
    const marketPrice = Number(mark.price) / PRICE_SCALE;
    const unrealizedPnl = unrealizedPnlAtMark(position, mark.price);
    if (position.marketPrice === marketPrice && position.unrealizedPnl === unrealizedPnl) return position;
    changed = true;
    return { ...position, marketPrice, unrealizedPnl };
  });
  return changed ? { ...data, positions } : data;
}

function unrealizedPnlAtMark(
  position: TradingLiveData["positions"][number],
  markPrice: bigint,
): number | undefined {
  const opening = position.privateState;
  if (!opening) return undefined;
  const entryPrice = BigInt(opening.entryPrice);
  const size = BigInt(opening.size);
  const entryFee = BigInt(opening.entryFee ?? "0");
  const delta = opening.side === "long" ? markPrice - entryPrice : entryPrice - markPrice;
  return protocolUsdcToDisplay((size * delta) / BigInt(PRICE_SCALE) - entryFee);
}

async function loadTradingData(session: WalletSession | null): Promise<TradingLiveData> {
  const [marketsResponse, health, portfolio] = await Promise.all([
    pnlxGet<MarketsResponse>("/markets", session?.token),
    pnlxGet<HealthResponse>("/health", session?.token),
    session ? fetchPortfolio(session) : Promise.resolve(undefined),
  ]);
  setPrivateMarginNoteRuntimeScope(privateMarginNoteRuntimeScopeFromHealth(health));
  let activePortfolio = portfolio;
  if (session && activePortfolio) {
    const keyStatus = await ensureAccountEncryptionKey(session);
    if (keyStatus.recovered) {
      activePortfolio = await fetchPortfolio(session);
    }
    void syncPrivateConditionalOrders(session, activePortfolio.accountEvents);
    reconcilePrivateMarginNotes({
      orders: [
        ...activePortfolio.orders,
        ...activePortfolio.activities.flatMap((activity): ReconciledPrivateMarginOrder[] => {
          if (activity.kind !== "order" || !isReconciledOrderStatus(activity.status)) return [];
          return [{
            intentCommitment: activity.id,
            status: activity.status,
          }];
        }),
      ],
    });
  }
  const publicMarkets = new Map(
    (activePortfolio?.publicState.markets ?? []).map((market) => [market.marketId, market]),
  );
  const privateOpeningPayloads = await decryptRecoverablePrivateOpenings(session, activePortfolio);
  const privateOpenings = new Map(
    privateOpeningPayloads.map(
      (payload) => [payload.opening.positionCommitment, payload.opening],
    ),
  );
  const tradedVolume = session && activePortfolio
    ? walletMatchedVolumeUsd(
        privateOpeningPayloads.map((payload) => payload.opening),
        activePortfolio.positions.map((position) => position.positionCommitment),
      )
    : null;
  const positionLockedMargin = activePortfolio?.positions.reduce((total, position) => {
    if (position.status !== "open") return total;
    const opening = privateOpenings.get(position.positionCommitment);
    return total + usdcAmount(opening?.margin);
  }, 0) ?? 0;
  const spendablePrivateMargin = session ? usdcAmount(privateSpendableBalance(session.ownerCommitment).toString()) : 0;
  const reservedPrivateMargin = session ? usdcAmount(privateReservedBalance(session.ownerCommitment).toString()) : 0;
  const pendingPrivateMargin = session ? usdcAmount(privatePendingBalance(session.ownerCommitment).toString()) : 0;
  const lockedMargin = positionLockedMargin + reservedPrivateMargin;
  const markets = canonicalMarkets(marketsResponse.markets).map((market) =>
    marketDisplayFromServer(market, publicMarkets.get(market.marketId)),
  );
  const marketPrices = new Map(markets.map((market) => [market.marketId, market.price]));

  return {
    account: accountFromServer(
      session,
      activePortfolio,
      lockedMargin,
      spendablePrivateMargin,
      pendingPrivateMargin,
      tradedVolume,
    ),
    accountEventCount: activePortfolio?.accountEvents.length ?? 0,
    activity: activePortfolio?.activities ?? [],
    markets,
    orders: activePortfolio?.orders ?? [],
    positions: activePortfolio?.positions.map((position) => {
      const opening = privateOpenings.get(position.positionCommitment);
      const entryPrice = priceAmount(opening?.entryPrice);
      const size = baseAmount(opening?.size);
      const collateral = usdcAmount(opening?.margin);
      const entryFee = usdcAmount(opening?.entryFee);
      const marketPrice = marketPrices.get(position.marketId);
      const unrealizedPnl = opening && typeof marketPrice === "number" && typeof entryPrice === "number"
        ? (opening.side === "long" ? marketPrice - entryPrice : entryPrice - marketPrice) * size - entryFee
        : undefined;

      return {
        batchId: position.batchId,
        boundlessRequestId: position.boundlessRequestId,
        closePrice: null,
        collateral: collateral || undefined,
        entryFee: opening?.entryFee === undefined ? undefined : entryFee,
        commitment: position.positionCommitment,
        entryPrice,
        id: position.positionCommitment,
        marketId: position.marketId,
        market: pairFromMarketId(position.marketId),
        marketPrice,
        netValue: collateral ? collateral + (unrealizedPnl ?? 0) + entryFee : undefined,
        openedAt: position.openedAt,
        journalDigest: position.journalDigest,
        lifecycleKind: position.lifecycleKind,
        lifecycleProofDigest: position.lifecycleProofDigest,
        lifecycleProofSystem: position.lifecycleProofSystem,
        lifecycleProofTxHash: position.lifecycleProofTxHash,
        lifecycleTxHash: position.lifecycleTxHash,
        proofDigest: position.proofDigest,
        proofSystem: position.proofSystem,
        proofVerificationTxHash: position.proofVerificationTxHash,
        privateState: opening
          ? {
              entryFee: opening.entryFee,
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
        settlementDigest: position.settlementDigest,
        settlementTxHash: position.settlementTxHash,
        sourceIntentCommitment: position.sourceIntentCommitment,
        status: position.status,
        time: formatTime(position.openedAt),
        unrealizedPnl,
      };
    }) ?? [],
    ticker: markets.map((market) => ({
      change: market.change24h,
      lastPrice: market.price,
      marketId: market.marketId,
      pair: market.pair,
    })),
  };
}

async function fetchPortfolio(session: WalletSession): Promise<ServerPortfolioSnapshot> {
  return pnlxGet<PortfolioResponse>(
    `/portfolio?ownerCommitment=${encodeURIComponent(session.ownerCommitment)}`,
    session.token,
  ).then((response) => response.portfolio);
}

async function decryptRecoverablePrivateOpenings(
  session: WalletSession | null,
  portfolio: ServerPortfolioSnapshot | undefined,
): Promise<Array<Extract<PrivateAccountEventPayload, { kind: "position-opening" }>>> {
  if (!session || !portfolio) return [];

  let activePortfolio = portfolio;
  let openings = await decryptPrivateOpenings(session, activePortfolio.accountEvents);
  if (shouldRecoverPrivateOpenings(session, activePortfolio, openings)) {
    markPrivateOpeningRecoveryAttempt(session, activePortfolio);
    try {
      await recoverAccountEncryptionKey(session);
      activePortfolio = await fetchPortfolio(session);
      openings = await decryptPrivateOpenings(session, activePortfolio.accountEvents);
      if (openings.length > 0) void syncPrivateConditionalOrders(session, activePortfolio.accountEvents);
    } catch {
      // Try the encrypted backup if the older key recovery path fails.
    }
  }
  const recovered = new Set(openings.map((payload) => payload.opening.positionCommitment.toLowerCase()));
  const missing = activePortfolio.positions
    .filter((position) => position.status === "open" && !recovered.has(position.positionCommitment.toLowerCase()))
    .map((position) => position.positionCommitment);
  if (missing.length) {
    const restored = await restorePrivateOpenings(session, missing).catch(() => []);
    openings = [...openings, ...restored];
  }
  const available = new Set(openings.map((payload) => payload.opening.positionCommitment.toLowerCase()));
  if (missing.some((commitment) => !available.has(commitment.toLowerCase()))) {
    setPrivateNoteBackupWarning("Some position details are unavailable. Reconnect your wallet.");
  }
  const openCommitments = new Set(activePortfolio.positions
    .filter((position) => position.status === "open")
    .map((position) => position.positionCommitment.toLowerCase()));
  void Promise.allSettled(openings
    .filter((payload) => openCommitments.has(payload.opening.positionCommitment.toLowerCase()))
    .map((payload) => backUpPrivateOpening(session, payload)))
    .then((results) => {
      if (results.some((result) => result.status === "rejected")) {
        setPrivateNoteBackupWarning("Position details could not sync. Reconnect your wallet.");
      }
    });
  return openings;
}

function shouldRecoverPrivateOpenings(
  session: WalletSession,
  portfolio: ServerPortfolioSnapshot,
  openings: Array<Extract<PrivateAccountEventPayload, { kind: "position-opening" }>>,
): boolean {
  const openPositionCommitments = portfolio.positions
    .filter((position) => position.status === "open")
    .map((position) => position.positionCommitment);
  if (openPositionCommitments.length === 0 || portfolio.accountEvents.length === 0) return false;

  const decrypted = new Set(openings.map((payload) => payload.opening.positionCommitment));
  const missingOpening = openPositionCommitments.some((commitment) => !decrypted.has(commitment));
  return missingOpening && !hasPrivateOpeningRecoveryAttempt(session, portfolio);
}

function privateOpeningRecoveryKey(
  session: WalletSession,
  portfolio: ServerPortfolioSnapshot,
): string {
  const commitments = portfolio.positions
    .filter((position) => position.status === "open")
    .map((position) => position.positionCommitment)
    .sort()
    .join("|");
  return `${PRIVATE_OPENING_RECOVERY_PREFIX}:${session.ownerCommitment}:${commitments}`;
}

function hasPrivateOpeningRecoveryAttempt(
  session: WalletSession,
  portfolio: ServerPortfolioSnapshot,
): boolean {
  return window.sessionStorage.getItem(privateOpeningRecoveryKey(session, portfolio)) === "1";
}

function markPrivateOpeningRecoveryAttempt(
  session: WalletSession,
  portfolio: ServerPortfolioSnapshot,
): void {
  window.sessionStorage.setItem(privateOpeningRecoveryKey(session, portfolio), "1");
}

function isReconciledOrderStatus(status: string | undefined): status is ReconciledPrivateMarginOrder["status"] {
  return status === "open" || status === "filled" || status === "partially-filled" || status === "cancelled";
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
  pendingPrivateMargin = 0,
  tradedVolume: number | null = null,
): AccountSnapshot {
  const privateTotal = lockedMargin + spendablePrivateMargin + pendingPrivateMargin;
  return {
    address: session?.address ?? "",
    accountValue: privateTotal,
    availableShieldedUsdc: spendablePrivateMargin,
    cash: spendablePrivateMargin,
    lockedMargin,
    livePnl: 0,
    marginRoot: portfolio?.publicState.marginRoot ?? portfolio?.publicState.marginMembershipRoot ?? ZERO_ROOT,
    pendingShieldedUsdc: pendingPrivateMargin,
    privacyMode: "shielded",
    shieldedUsdc: privateTotal,
    tradedVolume,
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
  return protocolUsdcToDisplay(value);
}

function priceAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  return Number(BigInt(value)) / PRICE_SCALE;
}

function baseAmount(value: string | undefined): number {
  return protocolBaseToDisplay(value);
}

function marketDisplayFromServer(
  market: ServerMarketConfig,
  publicMarket: ServerMarketPublicSnapshot | undefined,
): MarketDisplay {
  const baseAsset = baseAssetFromMarketId(market.marketId);
  const price = priceFromOracleString(market.oraclePrice);
  const aggregateVolume = market.volume !== undefined
    ? baseAmount(market.volume)
    : publicMarket
      ? baseAmount(publicMarket.aggregateVolume)
      : 0;
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
    fundingRate: market.fundingRate === undefined || market.fundingRate === null
      ? null
      : rateFromMicroBps(market.fundingRate) * 100,
    openInterest: market.openInterest === undefined || market.openInterest === null
      ? null
      : baseAmount(market.openInterest),
    oraclePrice: market.oraclePrice,
    pair: pairFromMarketId(market.marketId),
    price,
    quoteAsset: "USD",
    status: pending > 0 ? "settling" : "live",
    volume: aggregateVolume,
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
