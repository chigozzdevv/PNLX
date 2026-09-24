import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import { signWalletTransaction, type WalletSession } from "@/lib/wallet-auth";

const SCALE = 10_000_000n;
const MAX_I128 = (1n << 127n) - 1n;

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

interface PreparedVaultTransaction {
  action: VaultAction["action"];
  contractId: string;
  owner: string;
  txHash?: string;
  xdr: string;
}

type VaultAction =
  | { action: "deposit"; series: number; amount: string; minShares: string }
  | { action: "withdraw"; series: number; shares: string; minAssets: string }
  | { action: "request-withdraw"; series: number; shares: string }
  | { action: "claim-withdrawal"; series: number; minAssets: string };

export async function getVaultStatus(): Promise<VaultStatus> {
  const response = await pnlxGet<{ vault: VaultStatus }>("/liquidity-vault");
  return response.vault;
}

export async function getVaultAccount(session: WalletSession): Promise<VaultAccount> {
  const owner = encodeURIComponent(session.address);
  const response = await pnlxGet<{ account: VaultAccount }>(`/liquidity-vault/account?owner=${owner}`, session.token);
  return response.account;
}

export function parseVaultUnits(value: string): bigint {
  const normalized = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,7})?$/.test(normalized)) {
    throw new Error("Enter an amount with up to 7 decimal places");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(7, "0") || "0");
  if (units <= 0n) throw new Error("Amount must be greater than zero");
  if (units > MAX_I128) throw new Error("Amount is too large");
  return units;
}

export function formatVaultUnits(value: bigint | string, fractionDigits = 2): string {
  const amount = BigInt(value);
  const sign = amount < 0n ? "−" : "";
  const absolute = amount < 0n ? -amount : amount;
  const precision = 10n ** BigInt(fractionDigits);
  const divisor = SCALE / precision;
  const rounded = (absolute + divisor / 2n) / divisor;
  const whole = rounded / precision;
  const fraction = rounded % precision;
  return `${sign}${new Intl.NumberFormat("en-US").format(whole)}.${fraction.toString().padStart(fractionDigits, "0")}`;
}

export function quoteVaultAction(
  mode: "deposit" | "withdraw",
  amount: bigint,
  status: VaultStatus,
  account?: VaultAccount | null,
  selectedSeries?: number,
): { action: VaultAction; estimated: bigint; minimum: bigint } {
  if (mode === "deposit") {
    if (status.paused) {
      throw new Error("Deposits are not open right now");
    }
    const totalShares = BigInt(status.depositSeriesShares);
    const totalAssets = BigInt(status.depositSeriesAssets);
    if (totalShares === 0n && totalAssets !== 0n) throw new Error("Pool deposits are unavailable");
    if (totalShares > 0n && totalAssets <= 0n) throw new Error("Pool assets are unavailable");
    const estimated = totalShares === 0n ? amount : amount * totalShares / totalAssets;
    if (estimated <= 0n) throw new Error("Amount is too small to mint shares");
    const minimum = maxOne(estimated * 995n / 1000n);
    return { action: { action: "deposit", series: status.depositSeries, amount: amount.toString(), minShares: minimum.toString() }, estimated, minimum };
  }

  const position = account?.positions.find((item) => item.series === selectedSeries);
  if (!position || !position.withdrawalsOpen) throw new Error("Select a settled liquidity position");
  if (amount > BigInt(position.availableShares)) throw new Error("Amount exceeds available shares");
  const totalShares = BigInt(position.seriesTotalShares);
  const liquidAssets = BigInt(position.seriesAssets);
  if (totalShares <= 0n) throw new Error("Pool has no shares");
  const estimated = amount === totalShares ? liquidAssets : amount * liquidAssets / totalShares;
  if (estimated <= 0n) throw new Error("Amount is too small to withdraw USDC");
  const minimum = maxOne(estimated * 995n / 1000n);
  return { action: { action: "withdraw", series: position.series, shares: amount.toString(), minAssets: minimum.toString() }, estimated, minimum };
}

export function quoteVaultWithdrawalRequest(amount: bigint, position: VaultPosition): {
  action: VaultAction; estimated: bigint; minimum: bigint;
} {
  if (amount <= 0n || amount > BigInt(position.availableShares)) {
    throw new Error("Amount exceeds available shares");
  }
  return {
    action: { action: "request-withdraw", series: position.series, shares: amount.toString() },
    estimated: 0n,
    minimum: 0n,
  };
}

export function quoteVaultWithdrawalClaim(position: VaultPosition): {
  action: VaultAction; estimated: bigint; minimum: bigint;
} {
  if (!position.withdrawalsOpen || BigInt(position.pendingShares) <= 0n) {
    throw new Error("Withdrawal is not ready to claim");
  }
  const totalShares = BigInt(position.seriesTotalShares);
  if (totalShares <= 0n) throw new Error("Pool has no shares");
  const estimated = BigInt(position.pendingShares) * BigInt(position.seriesAssets) / totalShares;
  const minimum = estimated > 0n ? estimated * 995n / 1000n : 0n;
  return { action: { action: "claim-withdrawal", series: position.series,
    minAssets: minimum.toString() }, estimated, minimum };
}

export async function submitVaultAction(session: WalletSession, action: VaultAction): Promise<string> {
  const [prepared, health] = await Promise.all([
    pnlxPost<{ transaction: PreparedVaultTransaction }>(
      "/liquidity-vault/prepare",
      { owner: session.address, action },
      session.token,
    ),
    pnlxGet<{ stellar: { network: string; networkPassphrase: string } }>("/health", session.token),
  ]);
  if (prepared.transaction.action !== action.action || prepared.transaction.owner !== session.address) {
    throw new Error("Prepared vault transaction does not match your request");
  }
  const signedXdr = await signWalletTransaction(prepared.transaction.xdr, {
    address: session.address,
    network: health.stellar.network,
    networkPassphrase: health.stellar.networkPassphrase,
  });
  const result = await pnlxPost<{ relay: { submitted: boolean; txHash?: string } }>(
    "/relays/signed-xdr",
    { expectedTxHash: prepared.transaction.txHash, xdr: signedXdr },
    session.token,
  );
  if (!result.relay.submitted || !result.relay.txHash) {
    throw new Error("Vault transaction was not confirmed");
  }
  return result.relay.txHash;
}

function maxOne(value: bigint): bigint {
  return value > 0n ? value : 1n;
}
