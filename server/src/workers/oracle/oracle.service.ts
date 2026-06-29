import { spawnSync } from "node:child_process";
import { hashFields } from "@merkl/crypto";
import { PRICE_SCALE } from "@merkl/market-math";
import type { Hex } from "@merkl/protocol-types";
import type { CommandResult } from "@/workers/relayer/relayer.model";
import type { OracleConfig, OracleMarketPriceInput, OraclePrice, PythPriceResponse } from "@/workers/oracle/oracle.model";

export class OracleService {
  constructor(private readonly config: OracleConfig) {}

  async latestMarket(input: OracleMarketPriceInput): Promise<OraclePrice> {
    if (this.config.priceSource === "onchain-market") {
      return this.latestOnchainMarket(input.marketId, input.feedId);
    }
    return this.latest(input.feedId);
  }

  async latest(feedId: Hex): Promise<OraclePrice> {
    const url = new URL("/v2/updates/price/latest", this.config.hermesUrl);
    url.searchParams.append("ids[]", feedId.slice(2));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`pyth price fetch failed: ${response.status}`);
    }

    const body = (await response.json()) as PythPriceResponse;
    const parsed = body.parsed.find((entry) => entry.id === feedId.slice(2));
    if (!parsed) throw new Error("pyth feed missing from response");

    const price = scalePythPrice(BigInt(parsed.price.price), parsed.price.expo);
    const confidence = scalePythPrice(BigInt(parsed.price.conf), parsed.price.expo);
    const confidenceBps = (confidence * 10_000n) / abs(price);
    const age = Math.floor(Date.now() / 1000) - parsed.price.publish_time;

    if (price <= 0n) throw new Error("pyth price must be positive");
    if (age > this.config.maxAgeSeconds) throw new Error("pyth price is stale");
    if (confidenceBps > this.config.maxConfidenceBps) {
      throw new Error("pyth confidence interval too wide");
    }

    return {
      confidence,
      confidenceBps,
      feedId,
      price,
      publishTime: parsed.price.publish_time,
      source: "hermes",
    };
  }

  latestOnchainMarket(marketId: string, feedId: Hex): OraclePrice {
    const contractId = this.config.marketContractId?.trim();
    if (!contractId) throw new Error("MARKET_CONTRACT_ID is required for on-chain oracle reads");

    const command = [
      "stellar",
      "contract",
      "invoke",
      "--id",
      contractId,
      "--source",
      this.config.source || "merkl-testnet",
      "--network",
      this.config.network || "testnet",
      ...networkArgs(this.config),
      "--send",
      "no",
      "--",
      "mark_price",
      "--market_id",
      bytes32(hashFields("market-id", [marketId])),
    ];
    const runCommand = this.config.runCommand ?? defaultCommandRunner;
    const output = runCommand(command[0], command.slice(1));
    if (output.status !== 0) {
      throw new Error(`on-chain oracle read failed: ${output.stderr || output.stdout || output.status}`);
    }

    const price = parseMarketPrice(output.stdout);
    validateOnchainPrice(price, this.config.maxAgeSeconds);
    return {
      confidence: 0n,
      confidenceBps: 0n,
      feedId,
      price: price.price,
      publishTime: price.timestamp,
      source: "onchain-market",
    };
  }
}

interface ParsedMarketPrice {
  price: bigint;
  timestamp: number;
}

function scalePythPrice(value: bigint, expo: number): bigint {
  if (expo >= 0) return value * 10n ** BigInt(expo) * PRICE_SCALE;
  return (value * PRICE_SCALE) / 10n ** BigInt(-expo);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function networkArgs(config: OracleConfig): string[] {
  return [
    ...(config.rpcUrl ? ["--rpc-url", config.rpcUrl] : []),
    ...(config.networkPassphrase ? ["--network-passphrase", config.networkPassphrase] : []),
  ];
}

function defaultCommandRunner(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function parseMarketPrice(output: string): ParsedMarketPrice {
  const parsed = parseJsonPrice(output) ?? parseTextPrice(output);
  if (!parsed) throw new Error("on-chain oracle response missing price/timestamp");
  if (parsed.price <= 0n) throw new Error("on-chain oracle price must be positive");
  return parsed;
}

function parseJsonPrice(output: string): ParsedMarketPrice | undefined {
  try {
    return findPrice(JSON.parse(output));
  } catch {
    return undefined;
  }
}

function findPrice(value: unknown): ParsedMarketPrice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const price = numberLike(record.price);
  const timestamp = numberLike(record.timestamp);
  if (price !== undefined && timestamp !== undefined) {
    return { price, timestamp: Number(timestamp) };
  }
  for (const child of Object.values(record)) {
    const found = Array.isArray(child)
      ? child.map(findPrice).find(Boolean)
      : findPrice(child);
    if (found) return found;
  }
  return undefined;
}

function parseTextPrice(output: string): ParsedMarketPrice | undefined {
  const price = output.match(/price["'\s:=]+(-?\d+)/i);
  const timestamp = output.match(/timestamp["'\s:=]+(\d+)/i);
  if (!price || !timestamp) return undefined;
  return {
    price: BigInt(price[1]),
    timestamp: Number(timestamp[1]),
  };
}

function numberLike(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return undefined;
}

function validateOnchainPrice(price: ParsedMarketPrice, maxAgeSeconds: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (price.timestamp > now) throw new Error("on-chain oracle price is from the future");
  if (now - price.timestamp > maxAgeSeconds) throw new Error("on-chain oracle price is stale");
}

function bytes32(value: Hex | string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}
