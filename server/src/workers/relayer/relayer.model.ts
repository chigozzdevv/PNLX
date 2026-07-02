import type { Hex } from "@pnlx/protocol-types";

export interface RelayRequest {
  kind:
    | "deposit"
    | "intent"
    | "market"
    | "oracle-price"
    | "batch-settlement"
    | "withdraw"
    | "conditional-order"
    | "conditional-close"
    | "position-close"
    | "liquidation"
    | "disclosure"
    | "funding-settlement"
    | "signed-xdr"
    | "contract-invoke";
  payload: unknown;
}

export interface RelayedTx {
  command?: string[];
  commandOutputDigest?: Hex;
  commandStatus?: number | null;
  commitment?: Hex;
  contractId?: string;
  functionName?: string;
  relayId: Hex;
  kind: RelayRequest["kind"];
  mode: StellarRelayerConfig["mode"];
  payloadDigest: Hex;
  preparedXdrDigest?: Hex;
  sendMode?: "yes" | "no";
  submittedBy?: string;
  submittedAt: number;
  submitted: boolean;
  txHash?: Hex;
}

export interface StellarInvokePayload {
  args?: string[];
  autoSign?: boolean;
  buildOnly?: boolean;
  contractId: string;
  functionName: string;
  send?: "default" | "no" | "yes";
  source?: string;
}

export interface PreparedXdr {
  command: string[];
  commandOutputDigest: Hex;
  commandStatus: number | null;
  txHash?: Hex;
  xdr: string;
}

export interface ContractReadResult {
  command: string[];
  commandOutputDigest: Hex;
  commandStatus: number | null;
  output: string;
}

export interface StellarRelayerConfig {
  mode: "local" | "stellar-cli";
  network: string;
  networkPassphrase?: string;
  rpcUrl?: string;
  source: string;
}

export interface SignedXdrRelayInput {
  commitment?: Hex;
  expectedTxHash?: Hex;
  preparedXdrDigest?: Hex;
  submittedBy?: string;
  xdr: string;
}

export interface CommandResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;
