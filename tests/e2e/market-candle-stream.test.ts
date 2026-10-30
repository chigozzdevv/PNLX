import { describe, expect, test } from "bun:test";
import { MarketCandleStream, parseHyperliquidCandles } from "@/features/markets/market-candle-stream";

class TestSocket {
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 0;
  closed = false;
  sent: Array<Record<string, unknown>> = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
  open() { this.readyState = 1; this.onopen?.(new Event("open")); }
  emit(channel: string, data?: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ channel, data }) }));
  }
}
const input = { marketId: "xlm-usd-perp", interval: "1m" as const, limit: 300 };
const subscription = { coin: "XLM", interval: "1m", type: "candle" };
const row = { s: "XLM", i: "1m", t: Date.parse("2026-08-13T10:00:00Z"), o: "10", h: "12", l: "9", c: "11", n: 4, v: "12" };
const decoder = new TextDecoder();
async function read(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read(); return decoder.decode(result.value);
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await Bun.sleep(4);
  expect(check()).toBe(true);
}

describe("market candle streaming", () => {
  test("shares native subscriptions and keeps PNLX volume separate from exchange volume", async () => {
    const socket = new TestSocket();
    const stream = new MarketCandleStream(() => socket as unknown as WebSocket);
    const a = stream.stream(input, undefined, (candle) => ({ ...candle, volume: 3 })).body!.getReader();
    const b = stream.stream(input).body!.getReader();
    try {
      await read(a); await read(b); socket.open();
      expect(socket.sent.filter((item) => item.method === "subscribe")).toEqual([{ method: "subscribe", subscription }]);
      socket.emit("candle", row);
      const event = await read(a);
      expect(event).toContain('event: candle');
      expect(event).toContain('"volume":3');
      expect(event).toContain('"close":11');
      expect(event).toContain('"trades":4');
      expect(event).not.toContain('"price":');
      await a.cancel();
      expect(socket.sent.filter((item) => item.method === "unsubscribe")).toHaveLength(0);
    } finally { await b.cancel(); }
    expect(socket.closed).toBe(true);
  });
  test("only confirmed provider replies establish health for quiet markets", async () => {
    const socket = new TestSocket();
    const stream = new MarketCandleStream(() => socket as unknown as WebSocket);
    const reader = stream.stream(input).body!.getReader();
    try {
      expect(await read(reader)).toBe("retry: 1500\n\n"); socket.open();
      socket.emit("pong");
      expect(await read(reader)).toContain('"available":false');
      socket.emit("subscriptionResponse", { method: "subscribe", subscription });
      expect(await read(reader)).toContain('"available":true');
      socket.emit("pong");
      expect(await read(reader)).toContain('"available":true');
    } finally { await reader.cancel(); }
  });
  test("half-open upstream sockets become unavailable and reconnect", async () => {
    let now = 1_000;
    const sockets: TestSocket[] = [];
    const stream = new MarketCandleStream(() => { const s = new TestSocket(); sockets.push(s); return s as unknown as WebSocket; },
      () => now, { heartbeat: 2, silence: 20, reconnect: 1 });
    const reader = stream.stream(input).body!.getReader();
    try {
      await read(reader); sockets[0].open(); now += 21;
      await waitFor(() => sockets.length > 1);
      expect(sockets[0].closed).toBe(true);
      expect(await read(reader)).toContain('"available":false');
      sockets[1].open();
      expect(sockets[1].sent).toContainEqual({ method: "subscribe", subscription });
    } finally { await reader.cancel(); }
  });
  test("rejects other markets, malformed and unaligned candle updates", async () => {
    const socket = new TestSocket();
    const stream = new MarketCandleStream(() => socket as unknown as WebSocket);
    const reader = stream.stream(input).body!.getReader();
    try {
      await read(reader); socket.open();
      socket.emit("candle", { ...row, s: "BTC" });
      socket.emit("candle", { ...row, t: row.t + 1 });
      socket.emit("candle", { ...row, h: "1" });
      socket.emit("candle", row);
      expect(await read(reader)).toContain('event: candle');
    } finally { await reader.cancel(); }
    expect(() => parseHyperliquidCandles([{ ...row, n: -1 }])).toThrow();
    expect(() => parseHyperliquidCandles([{ ...row, c: "0xff" }])).toThrow();
  });

  test("subscribes to native four-hour candles and rejects hourly-aligned updates", async () => {
    const socket = new TestSocket();
    const stream = new MarketCandleStream(() => socket as unknown as WebSocket);
    const reader = stream.stream({ ...input, interval: "4h" }).body!.getReader();
    const alignedTime = Date.parse("2026-08-13T12:00:00.000Z");
    try {
      await read(reader);
      socket.open();
      expect(socket.sent).toContainEqual({
        method: "subscribe", subscription: { coin: "XLM", interval: "4h", type: "candle" },
      });
      socket.emit("candle", { ...row, i: "4h", t: alignedTime + 3_600_000, c: "10" });
      socket.emit("candle", { ...row, i: "4h", t: alignedTime, c: "11" });
      const event = await read(reader);
      expect(event).toContain('"interval":"4h"');
      expect(event).toContain('"time":"2026-08-13T12:00:00.000Z"');
      expect(event).toContain('"close":11');
    } finally { await reader.cancel(); }
  });
});
