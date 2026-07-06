#!/usr/bin/env bun
/**
 * Oracle Keeper — keeps the on-chain price-oracle fresh.
 *
 * Pushes a new price every INTERVAL_MS (default 4 min) using admin mode.
 * Falls back to the last known price if Pyth is unavailable.
 *
 * Usage:
 *   bun scripts/oracle-keeper.ts
 *
 * Env vars (loaded from .env):
 *   STELLAR_SOURCE         key alias (default: pnlx-testnet)
 *   STELLAR_NETWORK        network (default: testnet)
 *   STELLAR_RPC_URL        Soroban RPC URL
 *   ORACLE_CONTRACT_ID     price-oracle contract ID
 *   ORACLE_ASSET_ADDRESS   Stellar asset address for XLM (used with Stellar oracle asset type)
 *   ORACLE_ASSET_TYPE      stellar | other
 *   ORACLE_ASSET_SYMBOL    symbol for "other" type
 *   PYTH_HERMES_URL        https://hermes.pyth.network
 *   PYTH_XLM_USD_FEED_ID   Pyth feed ID for XLM/USD
 *   PNLX_MARKET_ID         market to keep (default: xlm-usd-perp)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INTERVAL_MS = 4 * 60 * 1000; // 4 minutes (max_age is 5 min)

// --- Env loading (minimal) ---
function loadEnvFile(path = join(process.cwd(), ".env")) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
}

loadEnvFile();

const SOURCE = process.env.STELLAR_SOURCE ?? "pnlx-testnet";
const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const ORACLE_CONTRACT = process.env.ORACLE_CONTRACT_ID ?? "";
const HERMES_URL = process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network";
const PRICE_DECIMALS = Number(process.env.ORACLE_PRICE_DECIMALS ?? "8");
const ASSET_TYPE = process.env.ORACLE_ASSET_TYPE ?? "other";
const ASSET_SYMBOL = process.env.ORACLE_ASSET_SYMBOL ?? "XLM";
const ASSET_ADDRESS = process.env.ORACLE_ASSET_ADDRESS ?? "";
const MARKET_ID = process.env.PNLX_MARKET_ID ?? "xlm-usd-perp";

// Pyth feed IDs per market
const FEED_IDS: Record<string, string> = {
  "xlm-usd-perp": process.env.PYTH_XLM_USD_FEED_ID ?? "b7a8eba68a997cd0210c2e1e4ee811ad2d174b3611c22d9ebf16f4cb7e9ba850",
  "btc-usd-perp": process.env.PYTH_BTC_USD_FEED_ID ?? "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "eth-usd-perp": process.env.PYTH_ETH_USD_FEED_ID ?? "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

interface PythPrice {
  price: bigint;
  timestamp: number;
}

async function fetchPythPrice(feedId: string): Promise<PythPrice> {
  const url = new URL("/v2/updates/price/latest", HERMES_URL);
  url.searchParams.append("ids[]", feedId.replace(/^0x/, ""));
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Pyth fetch failed: ${resp.status}`);
  const body = await resp.json() as any;
  const parsed = body.parsed?.find((e: any) => e.id === feedId.replace(/^0x/, ""));
  if (!parsed) throw new Error("Pyth feed not in response");
  const raw = BigInt(parsed.price.price);
  const expo = parsed.price.expo as number;
  // Scale to PRICE_DECIMALS
  let price: bigint;
  if (expo >= 0) {
    price = raw * 10n ** BigInt(expo) * 10n ** BigInt(PRICE_DECIMALS);
  } else {
    const negExp = -expo;
    if (negExp < PRICE_DECIMALS) {
      price = raw * 10n ** BigInt(PRICE_DECIMALS - negExp);
    } else {
      price = raw / 10n ** BigInt(negExp - PRICE_DECIMALS);
    }
  }
  return { price, timestamp: parsed.price.publish_time };
}

function pushPrice(price: bigint, timestamp: number): boolean {
  const isstellar = ASSET_TYPE === "stellar";
  const fn = isstellar ? "set_stellar_price" : "set_other_price";
  const assetArg = isstellar ? ASSET_ADDRESS : ASSET_SYMBOL;

  if (!assetArg) {
    console.error("Missing oracle asset (ORACLE_ASSET_ADDRESS or ORACLE_ASSET_SYMBOL)");
    return false;
  }

  const args = [
    "contract", "invoke",
    "--id", ORACLE_CONTRACT,
    "--source", SOURCE,
    "--network", NETWORK,
    "--rpc-url", RPC_URL,
    "--send", "yes",
    "--auto-sign",
    "--",
    fn,
    "--admin", sourceAddress(),
    "--asset", assetArg,
    "--price", price.toString(),
    "--timestamp", String(timestamp),
  ];

  const result = spawnSync("stellar", args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error("Oracle push failed:", result.stderr?.trim());
    return false;
  }
  return true;
}

let _sourceAddress: string | undefined;
function sourceAddress(): string {
  if (_sourceAddress) return _sourceAddress;
  const r = spawnSync("stellar", ["keys", "address", SOURCE], { encoding: "utf8" });
  _sourceAddress = r.stdout.trim();
  return _sourceAddress;
}

let lastPrice: bigint = 0n;
let lastTimestamp = 0;

async function tick() {
  const feedId = FEED_IDS[MARKET_ID];
  if (!feedId) {
    console.error(`No feed ID for market ${MARKET_ID}`);
    return;
  }

  let price = lastPrice;
  let timestamp = Math.floor(Date.now() / 1000);

  try {
    const pyth = await fetchPythPrice(feedId);
    price = pyth.price;
    timestamp = pyth.timestamp;
    lastPrice = price;
    lastTimestamp = timestamp;
    console.log(`[oracle-keeper] ${new Date().toISOString()} Pyth price: ${price} @ ${new Date(timestamp * 1000).toISOString()}`);
  } catch (e) {
    console.warn(`[oracle-keeper] Pyth fetch failed (using last known price ${price}):`, (e as Error).message);
    // Use current time with last known price if available
    if (price === 0n) {
      console.error("[oracle-keeper] No price available, skipping push.");
      return;
    }
  }

  const ok = pushPrice(price, timestamp);
  if (ok) {
    console.log(`[oracle-keeper] ✅ Oracle updated: price=${price} ts=${timestamp}`);
  } else {
    console.error(`[oracle-keeper] ❌ Oracle update failed.`);
  }
}

if (!ORACLE_CONTRACT) {
  console.error("ORACLE_CONTRACT_ID is not set. Check your .env file.");
  process.exit(1);
}

console.log(`[oracle-keeper] Starting — market=${MARKET_ID} oracle=${ORACLE_CONTRACT} interval=${INTERVAL_MS / 60000}m`);
console.log(`[oracle-keeper] Source=${SOURCE} Network=${NETWORK}`);

// Run immediately on start
await tick();

// Then run periodically
setInterval(tick, INTERVAL_MS);
