export interface SupportedPerpAsset {
  displaySymbol: string;
  initialMarginRate: bigint;
  marketId: string;
  maintenanceMarginRate: bigint;
  maxLeverage: bigint;
  oracleAssetAddress: string;
  oracleAssetSymbol: string;
  oracleAssetType: "other" | "stellar";
  pythFeedId: string;
  symbol: string;
}

export const SUPPORTED_PERP_ASSETS: Record<string, SupportedPerpAsset> = {
  BTC: {
    displaySymbol: "BTC/USD",
    initialMarginRate: 100_000n,
    marketId: "btc-usd-perp",
    maintenanceMarginRate: 50_000n,
    maxLeverage: 10n,
    oracleAssetAddress: "",
    oracleAssetSymbol: "BTC",
    oracleAssetType: "other",
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    symbol: "BTC",
  },
  ETH: {
    displaySymbol: "ETH/USD",
    initialMarginRate: 100_000n,
    marketId: "eth-usd-perp",
    maintenanceMarginRate: 50_000n,
    maxLeverage: 10n,
    oracleAssetAddress: "",
    oracleAssetSymbol: "ETH",
    oracleAssetType: "other",
    pythFeedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    symbol: "ETH",
  },
  XLM: {
    displaySymbol: "XLM/USD",
    initialMarginRate: 100_000n,
    marketId: "xlm-usd-perp",
    maintenanceMarginRate: 50_000n,
    maxLeverage: 10n,
    oracleAssetAddress: "",
    oracleAssetSymbol: "XLM",
    oracleAssetType: "other",
    pythFeedId: "b7a8eba68a997cd0210c2e1e4ee811ad2d174b3611c22d9ebf16f4cb7e9ba850",
    symbol: "XLM",
  },
  SOL: {
    displaySymbol: "SOL/USD",
    initialMarginRate: 200_000n,
    marketId: "sol-usd-perp",
    maintenanceMarginRate: 100_000n,
    maxLeverage: 5n,
    oracleAssetAddress: "",
    oracleAssetSymbol: "SOL",
    oracleAssetType: "other",
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    symbol: "SOL",
  },
  XRP: {
    displaySymbol: "XRP/USD",
    initialMarginRate: 200_000n,
    marketId: "xrp-usd-perp",
    maintenanceMarginRate: 100_000n,
    maxLeverage: 5n,
    oracleAssetAddress: "",
    oracleAssetSymbol: "XRP",
    oracleAssetType: "other",
    pythFeedId: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
    symbol: "XRP",
  },
};

export const DEFAULT_SMOKE_MARKET_SYMBOLS = ["BTC", "ETH", "XLM"];

export function getSupportedPerpAsset(symbol: string): SupportedPerpAsset {
  const normalized = symbol.trim().toUpperCase();
  const asset = SUPPORTED_PERP_ASSETS[normalized];
  if (!asset) {
    throw new Error(`unsupported perp asset ${symbol}`);
  }
  return asset;
}
