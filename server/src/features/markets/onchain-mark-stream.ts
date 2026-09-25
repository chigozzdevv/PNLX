import type { ParsedOnchainMarketPrice } from "@/workers/oracle/oracle.service";

const HEARTBEAT_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;

interface MarkStreamClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
  marketId: string;
}

interface MarkPriceUpdate {
  marketId: string;
  price: string;
  publishedAt: number;
  source: "onchain-market";
}

interface MarkUnavailableUpdate {
  marketId: string;
  source: "onchain-market";
}

export class OnchainMarkStream {
  private readonly clients = new Map<number, MarkStreamClient>();
  private readonly encoder = new TextEncoder();
  private readonly latest = new Map<string, ParsedOnchainMarketPrice>();
  private readonly unavailable = new Set<string>();
  private nextClientId = 1;
  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly readMark: (marketId: string) => Promise<ParsedOnchainMarketPrice>,
    private readonly maxAgeSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  stream(marketId: string, signal?: AbortSignal): Response {
    let clientId = 0;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        clientId = this.nextClientId++;
        const heartbeat = setInterval(() => {
          this.enqueue(clientId, `: heartbeat ${this.now()}\n\n`);
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
        this.clients.set(clientId, { controller, heartbeat, marketId });
        controller.enqueue(this.encoder.encode("retry: 1500\n\n"));
        const latest = this.latest.get(marketId);
        if (latest && !this.unavailable.has(marketId)) {
          try {
            this.assertFresh(latest);
            this.sendMark(clientId, marketId, latest);
          } catch {
            // Never seed a new client with a stale on-chain mark.
          }
        } else if (this.unavailable.has(marketId)) {
          this.sendUnavailable(clientId, marketId);
        }
        this.schedulePoll(0);
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

  private schedulePoll(delayMs = POLL_INTERVAL_MS): void {
    if (this.pollTimer || this.clients.size === 0) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll();
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private async poll(): Promise<void> {
    const marketIds = [...new Set([...this.clients.values()].map((client) => client.marketId))];
    await Promise.all(marketIds.map(async (marketId) => {
      try {
        const mark = await this.readMark(marketId);
        this.assertFresh(mark);
        this.latest.set(marketId, mark);
        this.unavailable.delete(marketId);
        this.broadcast(marketId, mark);
      } catch {
        this.broadcastUnavailable(marketId);
      }
    }));
    this.schedulePoll();
  }

  private assertFresh(mark: ParsedOnchainMarketPrice): void {
    const nowSeconds = Math.floor(this.now() / 1_000);
    if (mark.price <= 0n || mark.timestamp > nowSeconds || nowSeconds - mark.timestamp > this.maxAgeSeconds) {
      throw new Error("on-chain mark is invalid or stale");
    }
  }

  private broadcast(marketId: string, mark: ParsedOnchainMarketPrice): void {
    for (const [clientId, client] of this.clients) {
      if (client.marketId === marketId) this.sendMark(clientId, marketId, mark);
    }
  }

  private broadcastUnavailable(marketId: string): void {
    if (this.unavailable.has(marketId)) return;
    this.unavailable.add(marketId);
    for (const [clientId, client] of this.clients) {
      if (client.marketId === marketId) this.sendUnavailable(clientId, marketId);
    }
  }

  private sendUnavailable(clientId: number, marketId: string): void {
    this.enqueue(clientId, `event: unavailable\ndata: ${JSON.stringify({
      marketId,
      source: "onchain-market",
    } satisfies MarkUnavailableUpdate)}\n\n`);
  }

  private sendMark(clientId: number, marketId: string, mark: ParsedOnchainMarketPrice): void {
    this.enqueue(clientId, `event: mark\ndata: ${JSON.stringify({
      marketId,
      price: mark.price.toString(),
      publishedAt: mark.timestamp * 1_000,
      source: "onchain-market",
    } satisfies MarkPriceUpdate)}\n\n`);
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
    if (this.clients.size === 0 && this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
