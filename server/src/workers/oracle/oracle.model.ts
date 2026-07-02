import type { Hex } from "@pnlx/protocol-types";
import type { CommandRunner } from "@/workers/relayer/relayer.model";

export type OraclePriceSource = "hermes" | "onchain-market";

export interface OracleConfig {
  hermesUrl: string;
  marketContractId?: string;
  maxAgeSeconds: number;
  maxConfidenceBps: bigint;
  network?: string;
  networkPassphrase?: string;
  priceSource: OraclePriceSource;
  rpcUrl?: string;
  source?: string;
  runCommand?: CommandRunner;
}

export interface OraclePrice {
  confidence: bigint;
  confidenceBps: bigint;
  feedId: Hex;
  price: bigint;
  publishTime: number;
  source?: OraclePriceSource;
}

export interface OracleMarketPriceInput {
  feedId: Hex;
  marketId: string;
}

export interface PythPriceResponse {
  parsed: {
    id: string;
    price: {
      price: string;
      conf: string;
      expo: number;
      publish_time: number;
    };
  }[];
}
