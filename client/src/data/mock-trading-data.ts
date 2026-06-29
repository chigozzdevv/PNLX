import type { ChartCandle, Hex, TradingMockData } from "@/types/trading";

const PRICE_SCALE = 100_000_000;

const hex = (value: string): Hex => `0x${value}` as Hex;

function scaled(price: number): string {
  return Math.round(price * PRICE_SCALE).toString();
}

interface CandleSeed {
  seed: number;
  start: number;
  end: number;
  count?: number;
  volatility: number;
}

function candlesFromSeed({ seed, start, end, count = 118, volatility }: CandleSeed): ChartCandle[] {
  const candles: ChartCandle[] = [];
  const random = mulberry32(seed);
  let price = start;
  let drift = 0;
  let volatilityState = volatility;
  let volatilityTarget = volatility;

  for (let index = 0; index < count; index += 1) {
    const remaining = Math.max(count - index, 1);
    const targetPull = (end - price) / remaining;
    const burst = index % 31 === 0 ? (random() - 0.5) * volatility * 1.45 : 0;
    const reversal = index % 19 === 0 ? -drift * 0.42 : 0;

    if (index % 13 === 0) {
      volatilityTarget = volatility * (0.58 + random() * 0.58 + (index % 37 > 29 ? 0.28 : 0));
    }

    drift = drift * 0.68 + (random() - 0.5) * volatility * 0.52 + targetPull * 0.62 + burst + reversal;
    volatilityState = volatilityState * 0.78 + volatilityTarget * 0.22;

    const open = price;
    let close = open + drift + (random() - 0.5) * volatilityState * 0.46;

    if (index === count - 1) {
      close = end;
    }

    const body = Math.abs(close - open);
    const wickBase = volatilityState * (0.16 + random() * 0.34);
    const upperWick = wickBase + body * (0.08 + random() * 0.24);
    const lowerWick = wickBase * (0.82 + random() * 0.36) + body * (0.08 + random() * 0.24);
    const high = Math.max(open, close) + upperWick;
    const low = Math.max(0.0001, Math.min(open, close) - lowerWick);
    const minute = 9 * 60 + index * 5;

    candles.push({
      time: `${String(Math.floor((minute / 60) % 24)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
      open,
      high,
      low,
      close,
      volume: 46_000 + random() * 82_000 + body * 240 + (index % 23 > 17 ? 42_000 : 0),
    });

    price = close;
  }

  return candles;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const proof = {
  circuitId: "batch-match",
  circuitKey: hex("01b47d1744b6748ed5b1ac0ffee12031f0fd7b1c5e900fead0123456789abc01"),
  circuitHash: hex("8f14e45fceea167a5a36dedd4bea2543c0f47b1a97d423f7c86f7a0b51a923de"),
  verifierHash: hex("45c48cce2e2d7fbdea1afc51c7c6ad26f8082a7a00ecbe9173321d1a91f9825"),
  publicInputHash: hex("6512bd43d9caa6e02c990b0a82652dca2253451aac3a8a31dd361b02a7f0f112"),
  proofDigest: hex("aa72d01e4f9a2d7c56f8b9b0c5b811292e2ad050e8f7cf14955ad321c0ffee92"),
  bytecodeHash: hex("54d12d4adfb0afaa2df7ecf154263c8c7aa78afc091681d15baf273252de01ca"),
  witnessHash: hex("9d2a5f0eb7d9f7c2a8e5d77055ec716a39da1203187ecb1a7afe45c8d91e210a"),
  proofHash: hex("a9c4d55d9b76209014097f1204170bb3e8a21d0e33bb2c6509f9f7d3caa99d44"),
  publicInputsHash: hex("6512bd43d9caa6e02c990b0a82652dca2253451aac3a8a31dd361b02a7f0f112"),
  vkHash: hex("45c48cce2e2d7fbdea1afc51c7c6ad26f8082a7a00ecbe9173321d1a91f9825"),
};

export const mockTradingData: TradingMockData = {
  server: {
    health: { ok: true },
    markets: {
      markets: [
        {
          marketId: "btc-usd-perp",
          oraclePrice: scaled(59897.4),
          maxLeverage: "10",
          initialMarginRate: "100000",
          maintenanceMarginRate: "50000",
          fundingIndex: "17250",
        },
        {
          marketId: "eth-usd-perp",
          oraclePrice: scaled(3246.22),
          maxLeverage: "8",
          initialMarginRate: "125000",
          maintenanceMarginRate: "62500",
          fundingIndex: "9200",
        },
        {
          marketId: "sol-usd-perp",
          oraclePrice: scaled(151.76),
          maxLeverage: "6",
          initialMarginRate: "166000",
          maintenanceMarginRate: "83000",
          fundingIndex: "14400",
        },
        {
          marketId: "xlm-usd-perp",
          oraclePrice: scaled(0.1123),
          maxLeverage: "5",
          initialMarginRate: "200000",
          maintenanceMarginRate: "100000",
          fundingIndex: "3100",
        },
      ],
    },
    deposit: {
      note: {
        commitment: hex("a180dbd792e2a51a29fd019f64f69ac97c59ff5a21d55877b418bc88a947b8f1"),
        marginRoot: hex("f92b3bd81941e917101efe3e1797c448aaf3e6b25a2bb2da874adc8d18f790b9"),
      },
    },
    intent: {
      batchId: "batch-ui-1842",
      marketId: "btc-usd-perp",
      ownerCommitment: hex("cd6251b278307fcaf8f655edba798554e863c70b3f28f1cc05e7b678a6abd7d1"),
      intentCommitment: hex("01734721811ba91f11ca1a18c76cb6a644eb8c90c2d22c7b221bc78d19009f33"),
      shareCommitment: hex("ef5641ea6b54fc9860acb00e2dbfbf2a340ffbd981b0370bc2e908eb673bd7ad"),
      noteNullifier: hex("ed8d4135dfd03af054c0c8f2319bf41d49d60a6fa5f6f9d8d79556ea1762c029"),
    },
    settlement: {
      settlement: {
        batchId: "batch-ui-1842",
        marketId: "btc-usd-perp",
        oldRoot: hex("0000000000000000000000000000000000000000000000000000000000000000"),
        newRoot: hex("b07d4fb7abf4381f89da3bead790f177a38c851e3fa5f82e4079adea91f481aa"),
        newCommitments: [hex("2ad7106fb6f60fffd1746b16b9e56de7dd0ad4f1717cf99f339598788953f3b5")],
        spentNullifiers: [hex("ed8d4135dfd03af054c0c8f2319bf41d49d60a6fa5f6f9d8d79556ea1762c029")],
        fillCount: 1,
        aggregateVolume: "98900",
        openInterestDelta: "16511",
        residualSize: "0",
        proof,
      },
    },
    verifiers: {
      verifiers: [
        {
          circuitId: "batch-match",
          circuitKey: proof.circuitKey,
          circuitHash: proof.circuitHash,
          verifierHash: proof.verifierHash,
          verifierAuthority: "batch-match-proof-verifier",
          verifierContract: "proof-verifier",
        },
        {
          circuitId: "withdraw",
          circuitKey: hex("02f8ad4170bb120cafec5a51b47d1744b6748ed5b1ac091681d15baf273252d"),
          circuitHash: hex("70bba90e3f2fb64d9284e43d86d442071c4ac0ad9f4e06b0ef5641ea6b54fc98"),
          verifierHash: hex("8b2186fb3d62c2fc5c2f65df997edc47d28b4f4dc31deba8f2ba8830f1e9f31f"),
          verifierAuthority: "withdraw-proof-verifier",
          verifierContract: "proof-verifier",
        },
      ],
    },
  },
  account: {
    address: "0x77ea54ad78332ca86d76b6882f9c",
    accountValue: 0,
    cash: 0,
    livePnl: 0,
    marginRoot: hex("f92b3bd81941e917101efe3e1797c448aaf3e6b25a2bb2da874adc8d18f790b9"),
    privacyMode: "shielded",
  },
  markets: [
    {
      marketId: "btc-usd-perp",
      pair: "BTC/USD",
      baseAsset: "BTC",
      quoteAsset: "USD",
      assetName: "Bitcoin",
      price: 59897.4,
      change24h: 0.38,
      openInterestLong: 2_070_000,
      openInterestShort: 10_000_000,
      netRateLong: -0.0014,
      netRateShort: 0.0007,
      volume24h: 1_520_000,
      fundingIndex: "17250",
      maxLeverage: 10,
      initialMarginRate: 0.1,
      maintenanceMarginRate: 0.05,
      status: "live",
    },
    {
      marketId: "eth-usd-perp",
      pair: "ETH/USD",
      baseAsset: "ETH",
      quoteAsset: "USD",
      assetName: "Ethereum",
      price: 3246.22,
      change24h: -0.64,
      openInterestLong: 1_180_000,
      openInterestShort: 1_330_000,
      netRateLong: 0.0002,
      netRateShort: -0.0004,
      volume24h: 840_000,
      fundingIndex: "9200",
      maxLeverage: 8,
      initialMarginRate: 0.125,
      maintenanceMarginRate: 0.0625,
      status: "settling",
    },
    {
      marketId: "sol-usd-perp",
      pair: "SOL/USD",
      baseAsset: "SOL",
      quoteAsset: "USD",
      assetName: "Solana",
      price: 151.76,
      change24h: 7.65,
      openInterestLong: 560_000,
      openInterestShort: 410_000,
      netRateLong: -0.0008,
      netRateShort: 0.0005,
      volume24h: 410_000,
      fundingIndex: "14400",
      maxLeverage: 6,
      initialMarginRate: 0.166,
      maintenanceMarginRate: 0.083,
      status: "live",
    },
    {
      marketId: "xlm-usd-perp",
      pair: "XLM/USD",
      baseAsset: "XLM",
      quoteAsset: "USD",
      assetName: "Stellar",
      price: 0.1123,
      change24h: -3.13,
      openInterestLong: 128_000,
      openInterestShort: 160_000,
      netRateLong: 0.0001,
      netRateShort: -0.0002,
      volume24h: 91_000,
      fundingIndex: "3100",
      maxLeverage: 5,
      initialMarginRate: 0.2,
      maintenanceMarginRate: 0.1,
      status: "live",
    },
  ],
  candlesByMarket: {
    "btc-usd-perp": candlesFromSeed({
      seed: 98421,
      start: 59280,
      end: 59897.4,
      volatility: 118,
    }),
    "eth-usd-perp": candlesFromSeed({
      seed: 42109,
      start: 3292,
      end: 3246.22,
      volatility: 8.6,
    }),
    "sol-usd-perp": candlesFromSeed({
      seed: 67123,
      start: 142.4,
      end: 151.76,
      volatility: 0.42,
    }),
    "xlm-usd-perp": candlesFromSeed({
      seed: 19087,
      start: 0.116,
      end: 0.1123,
      volatility: 0.00042,
    }),
  },
  orderDraft: {
    side: "long",
    collateralAsset: "USDC",
    collateral: 100,
    estimatedSize: 0.016511,
    leverage: 10,
    takeProfitPrice: 63_000,
    stopLossPrice: 57_250,
  },
  positions: [],
  ticker: [
    { pair: "XLM/USD", change: -3.13 },
    { pair: "BTC/USD", change: 0.38 },
    { pair: "BNB/USD", change: 1.27 },
    { pair: "SOL/USD", change: 7.65 },
    { pair: "ETH/USD", change: -0.64 },
    { pair: "XRP/USD", change: 0.84 },
    { pair: "ADA/USD", change: -1.12 },
    { pair: "DOGE/USD", change: 2.48 },
    { pair: "AVAX/USD", change: 1.91 },
    { pair: "LINK/USD", change: -0.42 },
    { pair: "LTC/USD", change: 0.27 },
    { pair: "ATOM/USD", change: -2.06 },
  ],
};
