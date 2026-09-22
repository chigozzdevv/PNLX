export type VaultAction =
  | { action: "deposit"; amount: string; minShares: string }
  | { action: "withdraw"; shares: string; minAssets: string }
  | { action: "request-withdraw"; shares: string }
  | { action: "cancel-withdraw-request"; shares: string }
  | { action: "claim-withdrawal"; minAssets: string }
  | { action: "set-paused"; paused: boolean }
  | { action: "allocate"; amount: string }
  | { action: "settle"; principal: string; returned: string }
  | { action: "record-loss"; principal: string }
  | { action: "set-allocation-limit"; allocationLimitBps: number };

export interface PrepareVaultInput {
  owner: string;
  action: VaultAction;
}

export interface VaultStatus {
  allocationLimitBps: string;
  asset: string;
  contractId: string;
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
  withdrawn: string;
}

export interface PreparedVaultTransaction {
  action: VaultAction["action"];
  contractId: string;
  owner: string;
  txHash?: string;
  xdr: string;
}
