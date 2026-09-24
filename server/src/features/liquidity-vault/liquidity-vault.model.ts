export type VaultAction =
  | { action: "deposit"; series: number; amount: string; minShares: string }
  | { action: "withdraw"; series: number; shares: string; minAssets: string }
  | { action: "request-withdraw"; series: number; shares: string }
  | { action: "cancel-withdraw-request"; series: number; shares: string }
  | { action: "claim-withdrawal"; series: number; minAssets: string }
  | { action: "set-paused"; paused: boolean }
  | { action: "allocate"; series: number; amount: string }
  | { action: "settle"; series: number; principal: string; returned: string }
  | { action: "record-loss"; series: number; principal: string }
  | { action: "set-allocation-limit"; allocationLimitBps: number };

export interface PrepareVaultInput {
  owner: string;
  action: VaultAction;
}

export interface VaultStatus {
  allocationLimitBps: string;
  asset: string;
  contractId: string;
  currentSeries: number;
  currentSeriesAssets: string;
  currentSeriesLiquid: string;
  currentSeriesPrincipal: string;
  depositSeries: number;
  depositSeriesAssets: string;
  depositSeriesShares: string;
  deployedPrincipal: string;
  liquidAssets: string;
  maker: string;
  operator: string;
  paused: boolean;
  reconciledAssets: string | null;
  totalAssetsAtCost: string;
  totalShares: string;
  withdrawalsOpen: boolean;
}

export interface VaultAccount {
  address: string;
  availableShares: string;
  deposited: string;
  equity: string | null;
  pendingShares: string;
  shares: string;
  positions: VaultPosition[];
  withdrawn: string;
}

export interface VaultPosition {
  series: number;
  seriesAssets: string;
  seriesTotalShares: string;
  shares: string;
  pendingShares: string;
  availableShares: string;
  assetsAtCost: string;
  equity: string | null;
  withdrawalsOpen: boolean;
}

export interface PreparedVaultTransaction {
  action: VaultAction["action"];
  contractId: string;
  owner: string;
  txHash?: string;
  xdr: string;
}
