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
const CLIENT_HEARTBEAT_MS = 15_000;
const STREAM_IDLE_GRACE_MS = 30_000;
const HERMES_RECONNECT_MIN_MS = 1_000;
const HERMES_RECONNECT_MAX_MS = 15_000;
const HERMES_CONNECT_TIMEOUT_MS = 10_000;

type Fetcher = typeof fetch;

interface CandleCacheEntry {
  candles: MarketCandle[];
  expiresAt: number;
  fetchedAt: number;
  productId: string;
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
  source: "pyth-hermes";
}

export class MarketDataService {
  private readonly candleCache = new Map<string, CandleCacheEntry>();
  private readonly candleInflight = new Map<string, Promise<CandleCacheEntry>>();
  private readonly clients = new Map<number, StreamClient>();
  private readonly latestPrices = new Map<string, MarketPriceUpdate>();
  private readonly encoder = new TextEncoder();
  private nextClientId = 1;
  private hermesAbort?: AbortController;
  private hermesTask?: Promise<void>;
  private streamStopTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly env: ServerEnv,
    private readonly fetcher: Fetcher = globalThis.fetch,
  ) {}

  async candles(input: MarketCandlesInput) {
    const asset = supportedAsset(input.marketId);
    const key = `${input.marketId}:${input.interval}`;
    const cached = this.candleCache.get(key);
    const now = Date.now();

    if (cached) {
      if (cached.expiresAt <= now) {
        void this.refreshCandles(input.marketId, input.interval, asset.symbol).catch(() => undefined);
      }
      return candleResponse(input, cached, true, cached.expiresAt <= now);
    }

    const fresh = await this.refreshCandles(input.marketId, input.interval, asset.symbol);
    return candleResponse(input, fresh, false, false);
  }

  stream(marketId: string, signal?: AbortSignal): Response {
    supportedAsset(marketId);
    let clientId = 0;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        clientId = this.nextClientId++;
        const heartbeat = setInterval(() => {
          this.enqueue(clientId, `: heartbeat ${Date.now()}\n\n`);
        }, CLIENT_HEARTBEAT_MS);
        heartbeat.unref?.();
        this.clients.set(clientId, { controller, heartbeat, marketId });
        controller.enqueue(this.encoder.encode("retry: 1500\n\n"));
        const latest = this.latestPrices.get(marketId);
        if (latest) controller.enqueue(this.priceEvent(latest));
        this.ensureHermesStream();
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

  private async refreshCandles(
    marketId: string,
    interval: MarketCandleInterval,
    symbol: string,
  ): Promise<CandleCacheEntry> {
    const key = `${marketId}:${interval}`;
    const active = this.candleInflight.get(key);
    if (active) return active;

    const request = this.fetchPythCandles(interval, symbol)
      .then((entry) => {
        this.candleCache.set(key, entry);
        return entry;
      })
      .finally(() => this.candleInflight.delete(key));
    this.candleInflight.set(key, request);
    return request;
  }

  private async fetchPythCandles(
    interval: MarketCandleInterval,
    symbol: string,
  ): Promise<CandleCacheEntry> {
    const granularity = intervalSeconds(interval);
    const to = Math.floor(Date.now() / 1000);
    const from = to - granularity * CANDLE_CACHE_LIMIT;
    const productId = `Crypto.${symbol}/USD`;
    const url = new URL("https://benchmarks.pyth.network/v1/shims/tradingview/history");
    url.searchParams.set("symbol", productId);
    url.searchParams.set("resolution", pythResolution(interval));
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));

    const response = await fetchWithTimeout(this.fetcher, url, {
      headers: {
        accept: "application/json",
        "user-agent": "pnlx-pyth-candles/0.2",
      },
    }, CANDLE_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`candle provider failed with ${response.status}`);
    const candles = parsePythTradingViewCandles(await response.json());
    const fetchedAt = Date.now();
    return {
      candles: candles.slice(-CANDLE_CACHE_LIMIT),
      expiresAt: fetchedAt + CANDLE_CACHE_TTL_MS,
      fetchedAt,
      productId,
    };
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
            this.latestPrices.set(update.marketId, update);
            this.broadcast(update);
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", abortConnection);
      connection.abort();
    }
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
    if (this.clients.size === 0 && !this.streamStopTimer) {
      this.streamStopTimer = setTimeout(() => {
        this.streamStopTimer = undefined;
        if (this.clients.size === 0) this.hermesAbort?.abort();
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
    interval: input.interval,
    marketId: input.marketId,
    productId: entry.productId,
    realtime: true,
    source: "pyth-benchmarks",
    stale,
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
    const scaledPrice = Number(price.price) * (10 ** Number(price.expo));
    const scaledConfidence = Number(price.conf) * (10 ** Number(price.expo));
    const publishedAt = Number(price.publish_time) * 1_000;
    if (
      !Number.isFinite(scaledPrice) || scaledPrice <= 0 ||
      !Number.isFinite(scaledConfidence) || scaledConfidence < 0 ||
      !Number.isFinite(publishedAt) || publishedAt <= 0
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
  if (count === 0) throw new Error("candle provider returned no candles");

  const candles: MarketCandle[] = [];
  for (let index = 0; index < count; index += 1) {
    candles.push({
      close: closes[index],
      high: highs[index],
      low: lows[index],
      open: opens[index],
      time: new Date(times[index] * 1_000).toISOString(),
      volume: volumes[index] ?? 0,
    });
  }
  return candles;
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

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`missing candle ${label}`);
  return value.map((item) => {
    const number = Number(item);
    if (!Number.isFinite(number)) throw new Error(`invalid candle ${label}`);
    return number;
  });
}

async function fetchWithTimeout(
  fetcher: Fetcher,
  input: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`candle provider timed out after ${timeoutMs}ms`));
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

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
