import type { Hex } from "@pnlx/protocol-types";

export interface ProtocolLiquidityConfig {
  enabled: boolean;
  maxNotional: bigint;
  owner: string;
  publicKey?: string;
  quoteSpreadBps: bigint;
  tokenDigest: Hex;
}

export interface ProtocolLiquiditySeedResult {
  created: number;
  marketId: string;
}
