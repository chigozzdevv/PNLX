import { SUPPORTED_PERP_ASSETS } from "@/config/assets";
import type { ServerEnv } from "@/config/env";
import type {
  MarketCandle,
  MarketCandleInterval,
  MarketCandlesInput,
} from "@/features/markets/markets.model";

const CANDLE_CACHE_TTL_MS = 5_000;
const CANDLE_FETCH_TIMEOUT_MS = 5_000;
const CANDLE_CACHE_LIMIT = 300;
const CANDLE_CACHE_MAX_ENTRIES = 64;
const PROVIDER_FETCH_ATTEMPTS = 2;
const PROVIDER_RETRY_DELAY_MS = 150;
const PRICE_CACHE_TTL_MS = 750;
const PRICE_FETCH_TIMEOUT_MS = 5_000;
const CLIENT_HEARTBEAT_MS = 15_000;
const STREAM_IDLE_GRACE_MS = 30_000;
const HERMES_RECONNECT_MIN_MS = 1_000;
const HERMES_RECONNECT_MAX_MS = 15_000;
const HERMES_CONNECT_TIMEOUT_MS = 10_000;
const HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws";
const HYPERLIQUID_RECONNECT_MIN_MS = 1_000;
const HYPERLIQUID_RECONNECT_MAX_MS = 15_000;
const HYPERLIQUID_STREAM_IDLE_MS = 30_000;

type Fetcher = typeof fetch;
type WebSocketFactory = (url: string) => WebSocket;

interface CandleCacheEntry {
  candles: MarketCandle[];
  expiresAt: number;
  fetchedAt: number;
  from: number;
  hasMore: boolean;
  productId: string;
  source: "hyperliquid" | "pyth-pro-history";
  to: number;
}

interface StreamClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
  marketId: string;
}

export interface MarketPriceUpdate {
  confidence: number;
  marketId: string;
  price: number;
  publishedAt: number;
  source: "hyperliquid" | "pyth-hermes";
}

export class MarketDataService {
  private readonly candleCache = new Map<string, CandleCacheEntry>();
  private readonly candleInflight = new Map<string, Promise<CandleCacheEntry>>();
  private readonly clients = new Map<number, StreamClient>();
  private readonly latestPrices = new Map<string, MarketPriceUpdate>();
  private readonly latestPriceFetchedAt = new Map<string, number>();
  private readonly latestPriceInflight = new Map<string, Promise<MarketPriceUpdate>>();
  private readonly encoder = new TextEncoder();
  private nextClientId = 1;
  private hermesAbort?: AbortController;
  private hermesTask?: Promise<void>;
  private hyperliquidFallbackRunning = false;
  private hyperliquidIdleTimer?: ReturnType<typeof setTimeout>;
  private hyperliquidReconnectMs = HYPERLIQUID_RECONNECT_MIN_MS;
  private hyperliquidReconnectTimer?: ReturnType<typeof setTimeout>;
  private hyperliquidSocket?: WebSocket;
  private readonly hyperliquidSubscriptions = new Set<string>();
  private streamStopTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly env: ServerEnv,
    private readonly fetcher: Fetcher = globalThis.fetch,
    private readonly now: () => number = Date.now,
    private readonly webSocketFactory: WebSocketFactory = (url) => new WebSocket(url),
  ) {}

  async candles(input: MarketCandlesInput) {
    const asset = supportedAsset(input.marketId);
    const key = candleCacheKey(input);
    const cached = this.candleCache.get(key);
    const now = this.now();

    if (cached) {
      if (cached.expiresAt > now) return candleResponse(input, cached, true, false);
      try {
        const fresh = await this.refreshCandles(input, asset.symbol);
        return candleResponse(input, fresh, false, false);
      } catch {
        return candleResponse(input, cached, true, true);
      }
    }

    const fresh = await this.refreshCandles(input, asset.symbol);
    return candleResponse(input, fresh, false, false);
  }

  stream(marketId: string, signal?: AbortSignal): Response {
    supportedAsset(marketId);
    let clientId = 0;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        clientId = this.nextClientId++;
        const heartbeat = setInterval(() => {
          this.enqueue(clientId, `: heartbeat ${this.now()}\n\n`);
        }, CLIENT_HEARTBEAT_MS);
        heartbeat.unref?.();
        this.clients.set(clientId, { controller, heartbeat, marketId });
        controller.enqueue(this.encoder.encode("retry: 1500\n\n"));
        const latest = this.latestPrices.get(marketId);
        if (latest) controller.enqueue(this.priceEvent(latest));
        if (this.env.pythApiKey) {
          this.ensureHermesStream();
        } else {
          this.ensureHyperliquidPriceStream();
        }
      },
      cancel: () => this.removeClient(clientId),
    });

    if (signal) {
      signal.addEventListener("abort", () => this.removeClient(clientId), { once: true });
    }

    return new Response(body, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  }

  async latestPrice(marketId: string): Promise<MarketPriceUpdate> {
    supportedAsset(marketId);
    const cached = this.latestPrices.get(marketId);
    const fetchedAt = this.latestPriceFetchedAt.get(marketId) ?? 0;
    if (cached && fetchedAt + PRICE_CACHE_TTL_MS > this.now()) return cached;

    const active = this.latestPriceInflight.get(marketId);
    if (active) return active;
    const request = this.fetchLatestPrice(marketId)
      .finally(() => this.latestPriceInflight.delete(marketId));
    this.latestPriceInflight.set(marketId, request);
    return request;
  }

  private async refreshCandles(
    input: MarketCandlesInput,
    symbol: string,
  ): Promise<CandleCacheEntry> {
    const key = candleCacheKey(input);
    const active = this.candleInflight.get(key);
    if (active) return active;

    const request = this.fetchCandles(input, symbol)
      .then((entry) => {
        setBoundedCache(this.candleCache, key, entry);
        return entry;
      })
      .finally(() => this.candleInflight.delete(key));
    this.candleInflight.set(key, request);
    return request;
  }

  private fetchCandles(
    input: MarketCandlesInput,
    symbol: string,
  ): Promise<CandleCacheEntry> {
    return this.env.pythApiKey
      ? this.fetchPythProCandles(input, symbol)
      : this.fetchHyperliquidCandles(input, symbol);
  }

  private async fetchPythProCandles(
    input: MarketCandlesInput,
    symbol: string,
  ): Promise<CandleCacheEntry> {
    const granularity = intervalSeconds(input.interval);
    const to = input.to ?? Math.floor(this.now() / 1000);
    const requestedFrom = input.from ?? to - granularity * CANDLE_CACHE_LIMIT;
    const from = Math.max(requestedFrom, to - granularity * CANDLE_CACHE_LIMIT);
    const productId = `Crypto.${symbol}/USD`;
    const url = new URL("https://pyth.dourolabs.app/v1/fixed_rate@200ms/history");
    url.searchParams.set("symbol", productId);
    url.searchParams.set("resolution", pythResolution(input.interval));
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));

    const payload = await fetchJsonWithRetry(this.fetcher, url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.env.pythApiKey}`,
        "user-agent": "pnlx-pyth-candles/0.2",
      },
    }, CANDLE_FETCH_TIMEOUT_MS, "candle provider");
    const candles = parsePythTradingViewCandles(payload);
    const limitedCandles = candles.slice(-input.limit);
    const fetchedAt = this.now();
    return {
      candles: limitedCandles,
      expiresAt: fetchedAt + CANDLE_CACHE_TTL_MS,
      fetchedAt,
      from,
      hasMore: candles.length >= input.limit,
      productId,
      source: "pyth-pro-history",
      to,
    };
  }

  private async fetchHyperliquidCandles(
    input: MarketCandlesInput,
    symbol: string,
  ): Promise<CandleCacheEntry> {
    const granularity = intervalSeconds(input.interval);
    const to = input.to ?? Math.floor(this.now() / 1000);
    const requestedFrom = input.from ?? to - granularity * CANDLE_CACHE_LIMIT;
    const from = Math.max(requestedFrom, to - granularity * CANDLE_CACHE_LIMIT);
    const payload = await fetchJsonWithRetry(this.fetcher, new URL("https://api.hyperliquid.xyz/info"), {
      body: JSON.stringify({
        req: {
          coin: symbol,
          endTime: to * 1_000,
          interval: input.interval,
          startTime: from * 1_000,
        },
        type: "candleSnapshot",
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "pnlx-market-candles/0.3",
      },
      method: "POST",
    }, CANDLE_FETCH_TIMEOUT_MS, "candle provider");
    const candles = parseHyperliquidCandles(payload);
    const limitedCandles = candles.slice(-input.limit);
    const fetchedAt = this.now();
    return {
      candles: limitedCandles,
      expiresAt: fetchedAt + CANDLE_CACHE_TTL_MS,
      fetchedAt,
      from,
      hasMore: candles.length >= input.limit,
      productId: symbol,
      source: "hyperliquid",
      to,
    };
  }

  private async fetchLatestPrice(marketId: string): Promise<MarketPriceUpdate> {
    if (!this.env.pythApiKey) {
      const update = (await this.fetchHyperliquidPrices([marketId]))[0];
      if (!update) throw new Error(`price provider returned no update for ${marketId}`);
      if (this.cachePrice(update)) return update;
      this.latestPriceFetchedAt.set(marketId, this.now());
      return this.latestPrices.get(marketId) ?? update;
    }

    const feeds = feedMarkets(this.env);
    const feedId = [...feeds].find(([, candidate]) => candidate === marketId)?.[0];
    if (!feedId) throw new Error(`missing Pyth feed for ${marketId}`);
    const url = new URL("/v2/updates/price/latest", this.env.pythHermesUrl);
    url.searchParams.append("ids[]", feedId);
    url.searchParams.set("parsed", "true");
    const payload = await fetchJsonWithRetry(this.fetcher, url, {
      headers: {
        accept: "application/json",
        ...(this.env.pythApiKey ? { authorization: `Bearer ${this.env.pythApiKey}` } : {}),
      },
    }, PRICE_FETCH_TIMEOUT_MS, "price provider");
    const update = parseHermesPriceUpdates(JSON.stringify(payload), feeds)
      .find((candidate) => candidate.marketId === marketId);
    if (!update) throw new Error(`price provider returned no update for ${marketId}`);
    if (this.cachePrice(update)) return update;
    this.latestPriceFetchedAt.set(marketId, this.now());
    return this.latestPrices.get(marketId) ?? update;
  }

  private async fetchHyperliquidPrices(
    marketIds: string[],
  ): Promise<MarketPriceUpdate[]> {
    const payload = await fetchJsonWithRetry(
      this.fetcher,
      new URL("https://api.hyperliquid.xyz/info"),
      {
        body: JSON.stringify({ type: "allMids" }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "pnlx-market-prices/0.1",
        },
        method: "POST",
      },
      PRICE_FETCH_TIMEOUT_MS,
      "price provider",
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid price provider response");
    }

    const mids = payload as Record<string, unknown>;
    const publishedAt = this.now();
    return marketIds.flatMap((marketId) => {
      const symbol = supportedAsset(marketId).symbol;
      const price = strictNumber(mids[symbol]);
      if (price === undefined || price <= 0) return [];
      return [{
        confidence: 0,
        marketId,
        price,
        publishedAt,
        source: "hyperliquid" as const,
      }];
    });
  }

  private ensureHyperliquidPriceStream(): void {
    if (this.streamStopTimer) {
      clearTimeout(this.streamStopTimer);
      this.streamStopTimer = undefined;
    }
    if (this.hyperliquidSocket) {
      this.syncHyperliquidSubscriptions(this.hyperliquidSocket);
      return;
    }
    if (this.hyperliquidReconnectTimer || this.clients.size === 0) return;

    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(HYPERLIQUID_WS_URL);
    } catch (error) {
      console.error(`[MarketDataService] Hyperliquid stream failed: ${errorMessage(error)}`);
      void this.refreshHyperliquidFallback();
      this.scheduleHyperliquidReconnect();
      return;
    }
    this.hyperliquidSocket = socket;
    socket.onopen = () => {
      if (this.hyperliquidSocket !== socket) return;
      this.syncHyperliquidSubscriptions(socket);
      this.armHyperliquidIdleTimeout(socket);
    };
    socket.onmessage = (event) => {
      if (this.hyperliquidSocket !== socket) return;
      const marketIds = [...new Set([...this.clients.values()].map((client) => client.marketId))];
      const updates = parseHyperliquidAssetContextUpdates(event.data, marketIds, this.now());
      if (updates.length > 0) {
        this.hyperliquidReconnectMs = HYPERLIQUID_RECONNECT_MIN_MS;
        this.armHyperliquidIdleTimeout(socket);
      }
      for (const update of updates) {
        if (this.cachePrice(update)) this.broadcast(update);
      }
    };
    socket.onerror = () => {
      if (this.hyperliquidSocket === socket) socket.close();
    };
    socket.onclose = () => {
      if (this.hyperliquidSocket !== socket) return;
      if (this.hyperliquidIdleTimer) clearTimeout(this.hyperliquidIdleTimer);
      this.hyperliquidIdleTimer = undefined;
      this.hyperliquidSocket = undefined;
      this.hyperliquidSubscriptions.clear();
      void this.refreshHyperliquidFallback();
      this.scheduleHyperliquidReconnect();
    };
  }

  private syncHyperliquidSubscriptions(socket: WebSocket): void {
    if (socket.readyState !== 1) return;
    const desiredSymbols = new Set(
      [...this.clients.values()].map((client) => supportedAsset(client.marketId).symbol),
    );
    try {
      for (const symbol of this.hyperliquidSubscriptions) {
        if (desiredSymbols.has(symbol)) continue;
        socket.send(JSON.stringify({
          method: "unsubscribe",
          subscription: { coin: symbol, type: "activeAssetCtx" },
        }));
        this.hyperliquidSubscriptions.delete(symbol);
      }
      for (const symbol of desiredSymbols) {
        if (this.hyperliquidSubscriptions.has(symbol)) continue;
        socket.send(JSON.stringify({
          method: "subscribe",
          subscription: { coin: symbol, type: "activeAssetCtx" },
        }));
        this.hyperliquidSubscriptions.add(symbol);
      }
    } catch {
      socket.close();
    }
  }

  private armHyperliquidIdleTimeout(socket: WebSocket): void {
    if (this.hyperliquidIdleTimer) clearTimeout(this.hyperliquidIdleTimer);
    this.hyperliquidIdleTimer = setTimeout(() => {
      if (this.hyperliquidSocket === socket) socket.close();
    }, HYPERLIQUID_STREAM_IDLE_MS);
    this.hyperliquidIdleTimer.unref?.();
  }

  private async refreshHyperliquidFallback(): Promise<void> {
    if (this.hyperliquidFallbackRunning || this.clients.size === 0) return;
    this.hyperliquidFallbackRunning = true;
    try {
      const marketIds = [...new Set([...this.clients.values()].map((client) => client.marketId))];
      const updates = await this.fetchHyperliquidPrices(marketIds);
      for (const update of updates) {
        if (this.cachePrice(update)) this.broadcast(update);
      }
    } catch (error) {
      console.error(`[MarketDataService] Hyperliquid fallback failed: ${errorMessage(error)}`);
    } finally {
      this.hyperliquidFallbackRunning = false;
    }
  }

  private scheduleHyperliquidReconnect(): void {
    if (this.hyperliquidReconnectTimer || this.clients.size === 0 || this.env.pythApiKey) return;
    const reconnectMs = this.hyperliquidReconnectMs;
    this.hyperliquidReconnectMs = Math.min(
      reconnectMs * 2,
      HYPERLIQUID_RECONNECT_MAX_MS,
    );
    this.hyperliquidReconnectTimer = setTimeout(() => {
      this.hyperliquidReconnectTimer = undefined;
      this.ensureHyperliquidPriceStream();
    }, reconnectMs);
    this.hyperliquidReconnectTimer.unref?.();
  }

  private stopHyperliquidPriceStream(): void {
    if (this.hyperliquidIdleTimer) clearTimeout(this.hyperliquidIdleTimer);
    this.hyperliquidIdleTimer = undefined;
    if (this.hyperliquidReconnectTimer) clearTimeout(this.hyperliquidReconnectTimer);
    this.hyperliquidReconnectTimer = undefined;
    this.hyperliquidReconnectMs = HYPERLIQUID_RECONNECT_MIN_MS;
    this.hyperliquidSubscriptions.clear();
    const socket = this.hyperliquidSocket;
    this.hyperliquidSocket = undefined;
    socket?.close();
  }

  private ensureHermesStream(): void {
    if (this.streamStopTimer) {
      clearTimeout(this.streamStopTimer);
      this.streamStopTimer = undefined;
    }
    if (this.hermesTask || this.clients.size === 0) return;
    this.hermesAbort = new AbortController();
    this.hermesTask = this.runHermesStream(this.hermesAbort.signal).finally(() => {
      this.hermesTask = undefined;
      this.hermesAbort = undefined;
      if (this.clients.size > 0) this.ensureHermesStream();
    });
  }

  private async runHermesStream(signal: AbortSignal): Promise<void> {
    let reconnectMs = HERMES_RECONNECT_MIN_MS;
    while (!signal.aborted && this.clients.size > 0) {
      try {
        await this.consumeHermesStream(signal);
        reconnectMs = HERMES_RECONNECT_MIN_MS;
      } catch (error) {
        if (signal.aborted) return;
        console.error(`[MarketDataService] Hermes stream failed: ${errorMessage(error)}`);
      }
      await delay(reconnectMs, signal);
      reconnectMs = Math.min(reconnectMs * 2, HERMES_RECONNECT_MAX_MS);
    }
  }

  private async consumeHermesStream(signal: AbortSignal): Promise<void> {
    const feeds = feedMarkets(this.env);
    const url = new URL("/v2/updates/price/stream", this.env.pythHermesUrl);
    for (const feedId of feeds.keys()) url.searchParams.append("ids[]", feedId);
    url.searchParams.set("parsed", "true");
    const connection = new AbortController();
    const abortConnection = () => connection.abort();
    signal.addEventListener("abort", abortConnection, { once: true });
    let response: Response;
    try {
      response = await fetchStreamWithTimeout(this.fetcher, url, {
        headers: {
          accept: "text/event-stream",
          ...(this.env.pythApiKey ? { authorization: `Bearer ${this.env.pythApiKey}` } : {}),
        },
      }, connection, HERMES_CONNECT_TIMEOUT_MS);
    } catch (error) {
      signal.removeEventListener("abort", abortConnection);
      connection.abort();
      throw error;
    }
    if (!response.ok || !response.body) {
      signal.removeEventListener("abort", abortConnection);
      connection.abort();
      throw new Error(`Hermes stream failed with ${response.status}`);
    }

    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const data = event.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          for (const update of parseHermesPriceUpdates(data, feeds)) {
            if (!this.cachePrice(update)) continue;
            this.broadcast(update);
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", abortConnection);
      connection.abort();
    }
  }

  private cachePrice(update: MarketPriceUpdate): boolean {
    const current = this.latestPrices.get(update.marketId);
    if (current && current.publishedAt > update.publishedAt) return false;
    this.latestPrices.set(update.marketId, update);
    this.latestPriceFetchedAt.set(update.marketId, this.now());
    return true;
  }

  private broadcast(update: MarketPriceUpdate): void {
    const event = this.priceEvent(update);
    for (const [clientId, client] of this.clients) {
      if (client.marketId !== update.marketId) continue;
      try {
        client.controller.enqueue(event);
      } catch {
        this.removeClient(clientId);
      }
    }
  }

  private priceEvent(update: MarketPriceUpdate): Uint8Array {
    return this.encoder.encode(`event: price\ndata: ${JSON.stringify(update)}\n\n`);
  }

  private enqueue(clientId: number, value: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    try {
      client.controller.enqueue(this.encoder.encode(value));
    } catch {
      this.removeClient(clientId);
    }
  }

  private removeClient(clientId: number): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    clearInterval(client.heartbeat);
    this.clients.delete(clientId);
    if (!this.env.pythApiKey && this.clients.size > 0 && this.hyperliquidSocket) {
      this.syncHyperliquidSubscriptions(this.hyperliquidSocket);
    }
    if (this.clients.size === 0 && !this.streamStopTimer) {
      this.streamStopTimer = setTimeout(() => {
        this.streamStopTimer = undefined;
        if (this.clients.size !== 0) return;
        this.hermesAbort?.abort();
        this.stopHyperliquidPriceStream();
      }, STREAM_IDLE_GRACE_MS);
      this.streamStopTimer.unref?.();
    }
  }
}

function candleResponse(
  input: MarketCandlesInput,
  entry: CandleCacheEntry,
  cached: boolean,
  stale: boolean,
) {
  return {
    cached,
    candles: entry.candles.slice(-input.limit),
    fetchedAt: entry.fetchedAt,
    from: entry.from,
    hasMore: entry.hasMore,
    interval: input.interval,
    marketId: input.marketId,
    productId: entry.productId,
    realtime: true,
    source: entry.source,
    stale,
    to: entry.to,
  };
}

export function parseHermesPriceUpdates(
  raw: string,
  feeds: Map<string, string>,
): MarketPriceUpdate[] {
  const payload = JSON.parse(raw) as { parsed?: unknown };
  if (!Array.isArray(payload.parsed)) return [];
  return payload.parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const feedId = normalizeFeedId(String(record.id ?? ""));
    const marketId = feeds.get(feedId);
    const priceRecord = record.price;
    if (!marketId || !priceRecord || typeof priceRecord !== "object") return [];
    const price = priceRecord as Record<string, unknown>;
    const rawPrice = strictNumber(price.price);
    const rawConfidence = strictNumber(price.conf);
    const exponent = strictNumber(price.expo);
    const publishedSeconds = strictNumber(price.publish_time);
    if (
      rawPrice === undefined || rawPrice <= 0 ||
      rawConfidence === undefined || rawConfidence < 0 ||
      exponent === undefined || !Number.isInteger(exponent) ||
      publishedSeconds === undefined || publishedSeconds <= 0 ||
      !Number.isSafeInteger(publishedSeconds)
    ) return [];
    const scaledPrice = rawPrice * (10 ** exponent);
    const scaledConfidence = rawConfidence * (10 ** exponent);
    const publishedAt = publishedSeconds * 1_000;
    if (
      !Number.isFinite(scaledPrice) || scaledPrice <= 0 ||
      !Number.isFinite(scaledConfidence) || scaledConfidence < 0 ||
      !Number.isSafeInteger(publishedAt) || publishedAt <= 0
    ) return [];
    return [{
      confidence: scaledConfidence,
      marketId,
      price: scaledPrice,
      publishedAt,
      source: "pyth-hermes" as const,
    }];
  });
}

export function parsePythTradingViewCandles(payload: unknown): MarketCandle[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid candle provider response");
  }
  const response = payload as Record<string, unknown>;
  if (response.s === "no_data") return [];
  if (response.s !== "ok") {
    throw new Error(typeof response.errmsg === "string" ? response.errmsg : "candle provider returned no data");
  }
  const times = requiredArray(response.t, "time");
  const opens = requiredArray(response.o, "open");
  const highs = requiredArray(response.h, "high");
  const lows = requiredArray(response.l, "low");
  const closes = requiredArray(response.c, "close");
  const volumes = response.v === undefined ? undefined : requiredArray(response.v, "volume");
  const count = Math.min(times.length, opens.length, highs.length, lows.length, closes.length);
  if (count === 0) return [];

  const candles: MarketCandle[] = [];
  for (let index = 0; index < count; index += 1) {
    const time = strictNumber(times[index]);
    const open = strictNumber(opens[index]);
    const high = strictNumber(highs[index]);
    const low = strictNumber(lows[index]);
    const close = strictNumber(closes[index]);
    const volume = volumes?.[index] === undefined ? 0 : strictNumber(volumes[index]);
    if (
      time === undefined || time <= 0 || !Number.isSafeInteger(time) ||
      open === undefined || open <= 0 ||
      high === undefined || high <= 0 ||
      low === undefined || low <= 0 ||
      close === undefined || close <= 0 ||
      volume === undefined || volume < 0 ||
      high < Math.max(open, close) || low > Math.min(open, close)
    ) continue;
    const timestamp = new Date(time * 1_000);
    if (!Number.isFinite(timestamp.getTime())) continue;
    candles.push({
      close,
      high,
      low,
      open,
      time: timestamp.toISOString(),
      volume,
    });
  }
  if (candles.length === 0) throw new Error("candle provider returned no valid candles");
  return candles;
}

export function parseHyperliquidCandles(payload: unknown): MarketCandle[] {
  if (!Array.isArray(payload)) throw new Error("invalid candle provider response");

  const candles = payload.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const time = strictNumber(record.t);
    const open = strictNumber(record.o);
    const high = strictNumber(record.h);
    const low = strictNumber(record.l);
    const close = strictNumber(record.c);
    const volume = strictNumber(record.v);
    if (
      time === undefined || time <= 0 || !Number.isSafeInteger(time) ||
      open === undefined || open <= 0 ||
      high === undefined || high <= 0 ||
      low === undefined || low <= 0 ||
      close === undefined || close <= 0 ||
      volume === undefined || volume < 0 ||
      high < Math.max(open, close) || low > Math.min(open, close)
    ) return [];
    const timestamp = new Date(time);
    if (!Number.isFinite(timestamp.getTime())) return [];
    return [{
      close,
      high,
      low,
      open,
      time: timestamp.toISOString(),
      volume,
    }];
  });
  if (payload.length > 0 && candles.length === 0) {
    throw new Error("candle provider returned no valid candles");
  }
  return candles;
}

export function parseHyperliquidAssetContextUpdates(
  raw: unknown,
  marketIds: string[],
  publishedAt: number,
): MarketPriceUpdate[] {
  if (typeof raw !== "string" || !Number.isSafeInteger(publishedAt) || publishedAt <= 0) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const message = payload as Record<string, unknown>;
  if (message.channel !== "activeAssetCtx" || !message.data || typeof message.data !== "object") return [];
  const data = message.data as Record<string, unknown>;
  const symbol = typeof data.coin === "string" ? data.coin : "";
  const marketId = marketIds.find((candidate) => supportedAsset(candidate).symbol === symbol);
  if (!marketId || !data.ctx || typeof data.ctx !== "object" || Array.isArray(data.ctx)) return [];
  const context = data.ctx as Record<string, unknown>;
  const price = [context.midPx, context.markPx, context.oraclePx]
    .map(strictNumber)
    .find((candidate) => candidate !== undefined && candidate > 0);
  if (price === undefined) return [];
  return [{
    confidence: 0,
    marketId,
    price,
    publishedAt,
    source: "hyperliquid",
  }];
}

function candleCacheKey(input: MarketCandlesInput): string {
  if (input.from === undefined && input.to === undefined) {
    return `${input.marketId}:${input.interval}:latest:${input.limit}`;
  }
  return `${input.marketId}:${input.interval}:${input.from ?? "auto"}:${input.to ?? "now"}:${input.limit}`;
}

function setBoundedCache<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CANDLE_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function feedMarkets(env: ServerEnv): Map<string, string> {
  return new Map(Object.values(SUPPORTED_PERP_ASSETS).map((asset) => [
    normalizeFeedId(env.pythFeedIds[asset.symbol] ?? asset.pythFeedId),
    asset.marketId,
  ]));
}

function supportedAsset(marketId: string) {
  const asset = Object.values(SUPPORTED_PERP_ASSETS).find((candidate) => candidate.marketId === marketId);
  if (!asset) throw new Error(`unsupported candle market ${marketId}`);
  return asset;
}

function normalizeFeedId(feedId: string): string {
  return feedId.replace(/^0x/i, "").toLowerCase();
}

function intervalSeconds(interval: MarketCandleInterval): number {
  return {
    "1d": 86_400,
    "1h": 3_600,
    "1m": 60,
    "5m": 300,
    "15m": 900,
  }[interval];
}

function pythResolution(interval: MarketCandleInterval): string {
  if (interval === "1d") return "D";
  return String(intervalSeconds(interval) / 60);
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`missing candle ${label}`);
  return value;
}

function strictNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function fetchJsonWithRetry(
  fetcher: Fetcher,
  input: URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchJsonWithTimeout(fetcher, input, init, timeoutMs, label);
    } catch (error) {
      lastError = error;
      if (attempt < PROVIDER_FETCH_ATTEMPTS) await delay(PROVIDER_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function fetchJsonWithTimeout(
  fetcher: Fetcher,
  input: URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetcher(input, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} failed with ${response.status}`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function fetchStreamWithTimeout(
  fetcher: Fetcher,
  input: URL,
  init: RequestInit,
  controller: AbortController,
  timeoutMs: number,
): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Hermes stream connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([
      fetcher(input, { ...init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
