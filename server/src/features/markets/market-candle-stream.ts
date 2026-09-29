import { SUPPORTED_PERP_ASSETS } from "@/config/assets";
import type { MarketCandle, MarketCandlesInput } from "@/features/markets/markets.model";

const WS_URL = "wss://api.hyperliquid.xyz/ws";
const HEARTBEAT_MS = 5_000;
const MAX_SILENCE_MS = 25_000;

type CandleInput = Pick<MarketCandlesInput, "marketId" | "interval">;
type CandleMapper = (candle: MarketCandle) => MarketCandle;

interface CandleClient {
  input: CandleInput;
  controller: ReadableStreamDefaultController<Uint8Array>;
  map: CandleMapper;
}

export class MarketCandleStream {
  private readonly clients = new Map<number, CandleClient>();
  private readonly subscriptions = new Map<string, { coin: string; interval: string; type: "candle" }>();
  private readonly confirmed = new Set<string>();
  private readonly requestedAt = new Map<string, number>();
  private readonly encoder = new TextEncoder();
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private lastReplyAt = 0;
  private reconnectMs = 1_000;
  private nextClientId = 0;

  constructor(
    private readonly socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
    private readonly now: () => number = Date.now,
    private readonly timing: { heartbeat?: number; silence?: number; reconnect?: number } = {},
  ) {}

  stream(input: CandleInput, signal?: AbortSignal, map: CandleMapper = (candle) => candle): Response {
    const asset = Object.values(SUPPORTED_PERP_ASSETS).find((item) => item.marketId === input.marketId);
    if (!asset) throw new Error("unsupported candle market");
    let clientId = 0;
    const abort = () => this.removeClient(clientId);
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        clientId = ++this.nextClientId;
        this.clients.set(clientId, { controller, input, map });
        controller.enqueue(this.encoder.encode("retry: 1500\n\n"));
        if (signal?.aborted) {
          this.removeClient(clientId);
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        this.connect();
        this.syncSubscriptions();
      },
      cancel: () => {
        signal?.removeEventListener("abort", abort);
        this.removeClient(clientId);
      },
    });
    return new Response(body, { headers: {
      "cache-control": "no-cache, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    } });
  }

  private connect(): void {
    if (this.socket || this.reconnect || this.clients.size === 0) return;
    let socket: WebSocket;
    try {
      socket = this.socketFactory(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.lastReplyAt = this.now();
    this.heartbeat = setInterval(() => {
      const silence = this.timing.silence ?? MAX_SILENCE_MS;
      if (this.now() - this.lastReplyAt > silence || [...this.requestedAt].some(
        ([key, at]) => !this.confirmed.has(key) && this.now() - at > silence,
      )) {
        this.disconnect(socket);
      } else if (socket.readyState === 1) {
        this.sendMessage({ method: "ping" });
      }
    }, this.timing.heartbeat ?? HEARTBEAT_MS);
    this.heartbeat.unref?.();
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.syncSubscriptions();
      this.sendMessage({ method: "ping" });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as Record<string, unknown>;
        if (message.channel === "pong") {
          this.lastReplyAt = this.now();
          this.reconnectMs = this.timing.reconnect ?? 1_000;
          this.sendHealth(true);
        } else if (message.channel === "subscriptionResponse") {
          const data = message.data as { method?: string; subscription?: { coin?: string; interval?: string; type?: string } };
          if (data?.method !== "subscribe" || data.subscription?.type !== "candle") return;
          const key = `${data.subscription.coin}:${data.subscription.interval}`;
          if (!this.subscriptions.has(key)) return;
          this.confirmed.add(key);
          this.lastReplyAt = this.now();
          this.sendHealth(true);
        } else if (message.channel === "candle") {
          const rows = Array.isArray(message.data) ? message.data : [message.data];
          for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            const record = row as Record<string, unknown>;
            const key = `${record.s}:${record.i}`;
            if (!this.subscriptions.has(key)) continue;
            const candle = parseHyperliquidCandles([row])[0];
            if (!candle || Date.parse(candle.time) % candleIntervalMs(String(record.i)) !== 0) continue;
            this.confirmed.add(key);
            this.lastReplyAt = this.now();
            this.reconnectMs = 1_000;
            for (const [id, client] of this.clients) {
              if (subscriptionKey(client.input) !== key) continue;
              this.send(id, "candle", {
                candle: client.map(candle),
                checkedAt: this.now(),
                interval: client.input.interval,
                marketId: client.input.marketId,
                source: "hyperliquid",
              });
            }
            this.sendHealth(true);
          }
        }
      } catch {
        // Ignore invalid provider messages without refreshing feed health.
      }
    };
    socket.onerror = () => this.disconnect(socket);
    socket.onclose = () => this.disconnect(socket);
  }

  private syncSubscriptions(): void {
    if (this.socket?.readyState !== 1) return;
    const desired = new Map([...this.clients.values()].map(({ input }) => [subscriptionKey(input), {
      coin: assetSymbol(input.marketId), interval: input.interval, type: "candle" as const,
    }]));
    for (const [key, subscription] of this.subscriptions) {
      if (desired.has(key)) continue;
      if (!this.sendMessage({ method: "unsubscribe", subscription })) return;
      this.subscriptions.delete(key);
      this.confirmed.delete(key);
      this.requestedAt.delete(key);
    }
    for (const [key, subscription] of desired) {
      if (this.subscriptions.has(key)) continue;
      if (!this.sendMessage({ method: "subscribe", subscription })) return;
      this.subscriptions.set(key, subscription);
      this.requestedAt.set(key, this.now());
    }
  }

  private sendHealth(available: boolean): void {
    for (const [id, client] of this.clients) {
      this.send(id, "health", {
        available: available && this.confirmed.has(subscriptionKey(client.input)),
        checkedAt: this.now(),
        interval: client.input.interval,
        marketId: client.input.marketId,
        source: "hyperliquid",
      });
    }
  }

  private sendMessage(message: unknown): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(message)); return true; }
    catch { this.disconnect(socket); return false; }
  }

  private send(id: number, event: string, data: unknown): void {
    try {
      this.clients.get(id)?.controller.enqueue(this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      this.removeClient(id);
    }
  }

  private disconnect(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.subscriptions.clear();
    this.confirmed.clear();
    this.requestedAt.clear();
    this.sendHealth(false);
    socket.close();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnect || this.clients.size === 0) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.connect();
    }, this.timing.reconnect ?? this.reconnectMs);
    this.reconnect.unref?.();
    this.reconnectMs = Math.min(15_000, this.reconnectMs * 2);
  }

  private removeClient(id: number): void {
    const client = this.clients.get(id);
    this.clients.delete(id);
    try { client?.controller.close(); } catch { /* Stream may already be cancelled. */ }
    if (this.clients.size > 0) {
      this.syncSubscriptions();
      return;
    }
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reconnect = undefined;
    this.heartbeat = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.subscriptions.clear();
    this.confirmed.clear();
    this.requestedAt.clear();
    socket?.close();
  }
}

function assetSymbol(marketId: string): string {
  return Object.values(SUPPORTED_PERP_ASSETS).find((item) => item.marketId === marketId)!.symbol;
}

function subscriptionKey(input: CandleInput): string {
  return `${assetSymbol(input.marketId)}:${input.interval}`;
}

function candleIntervalMs(interval: string): number {
  return ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000 } as Record<string, number>)[interval] ?? 0;
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
    const trades = record.n === undefined ? undefined : strictNumber(record.n);
    if (time === undefined || !Number.isSafeInteger(time) || time <= 0 ||
      open === undefined || open <= 0 || high === undefined || high <= 0 ||
      low === undefined || low <= 0 || close === undefined || close <= 0 ||
      volume === undefined || volume < 0 || high < Math.max(open, close) || low > Math.min(open, close) ||
      (record.n !== undefined && (trades === undefined || !Number.isSafeInteger(trades) || trades < 0))) return [];
    const timestamp = new Date(time);
    if (!Number.isFinite(timestamp.getTime())) return [];
    return [{ close, high, low, open, time: timestamp.toISOString(), ...(trades === undefined ? {} : { trades }), volume }];
  });
  if (payload.length > 0 && candles.length === 0) throw new Error("candle provider returned no valid candles");
  return candles;
}

function strictNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}
