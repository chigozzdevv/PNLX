import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import type {
  PreparedVaultTransaction,
  VaultAccount,
  VaultAction,
  VaultStatus,
} from "@/features/liquidity-vault/liquidity-vault.model";

type VaultRelayer = Pick<RelayerService, "readAsync" | "prepareXdr">;

export class LiquidityVaultService {
  constructor(
    private readonly relayer: VaultRelayer,
    private readonly deployment?: DeploymentRegistry,
  ) {}

  async status(): Promise<VaultStatus> {
    const contractId = this.contractId();
    const [asset, operator, maker, paused, liquidAssets, deployedPrincipal, totalShares, allocationLimitBps] =
      await Promise.all([
        this.read("asset", [], parseAddress),
        this.read("operator", [], parseAddress),
        this.read("maker", [], parseAddress),
        this.read("paused", [], parseBoolean),
        this.read("liquid_assets", [], parseInteger),
        this.read("deployed_principal", [], parseInteger),
        this.read("total_shares", [], parseInteger),
        this.read("allocation_limit_bps", [], parseInteger),
      ]);
    return {
      allocationLimitBps,
      asset,
      contractId,
      deployedPrincipal,
      liquidAssets,
      maker,
      operator,
      paused,
      reconciledAssets: deployedPrincipal === "0" ? liquidAssets : null,
      totalAssetsAtCost: (BigInt(liquidAssets) + BigInt(deployedPrincipal)).toString(),
      totalShares,
      withdrawalsOpen: deployedPrincipal === "0",
    };
  }

  async account(owner: string): Promise<VaultAccount> {
    const address = parseAddress(owner);
    const args = ["--owner", address];
    const [shares, pendingShares, availableShares, deposited, withdrawn, deployedPrincipal] = await Promise.all([
      this.read("shares", args, parseInteger),
      this.read("pending_shares", args, parseInteger),
      this.read("available_shares", args, parseInteger),
      this.read("deposited", args, parseInteger),
      this.read("withdrawn", args, parseInteger),
      this.read("deployed_principal", [], parseInteger),
    ]);
    const equity = deployedPrincipal === "0"
      ? await this.read("equity", args, parseInteger)
      : null;
    return { address, availableShares, deposited, equity, pendingShares, shares, withdrawn };
  }

  prepare(owner: string, action: VaultAction): PreparedVaultTransaction {
    const address = parseAddress(owner);
    const invocation = actionInvocation(address, action);
    const prepared = this.relayer.prepareXdr({
      kind: "contract-invoke",
      payload: {
        args: invocation.args,
        buildOnly: true,
        contractId: this.contractId(),
        functionName: invocation.method,
        send: "no",
        source: address,
      },
    });
    return {
      action: action.action,
      contractId: this.contractId(),
      owner: address,
      txHash: prepared.txHash,
      xdr: prepared.xdr,
    };
  }

  private contractId(): string {
    const id = this.deployment?.contracts["liquidity-vault"];
    if (!id) throw new Error("liquidity vault is not deployed");
    return id;
  }

  private async read<T>(method: string, args: string[], parse: (value: string) => T): Promise<T> {
    const result = await this.relayer.readAsync({
      kind: "contract-invoke",
      payload: {
        args,
        contractId: this.contractId(),
        functionName: method,
        send: "no",
      },
    });
    return parse(result.output);
  }
}

function actionInvocation(owner: string, action: VaultAction): { method: string; args: string[] } {
  switch (action.action) {
    case "deposit":
      return {
        method: "deposit",
        args: ["--from", owner, "--amount", positiveInteger(action.amount), "--min_shares", nonnegativeInteger(action.minShares)],
      };
    case "withdraw":
      return {
        method: "withdraw",
        args: ["--owner", owner, "--shares", positiveInteger(action.shares), "--min_assets", nonnegativeInteger(action.minAssets)],
      };
    case "request-withdraw":
      return { method: "request_withdraw", args: ["--owner", owner, "--shares", positiveInteger(action.shares)] };
    case "cancel-withdraw-request":
      return { method: "cancel_withdraw_request", args: ["--owner", owner, "--shares", positiveInteger(action.shares)] };
    case "claim-withdrawal":
      return { method: "claim_withdrawal", args: ["--owner", owner, "--min_assets", nonnegativeInteger(action.minAssets)] };
    case "set-paused":
      if (typeof action.paused !== "boolean") throw new Error("paused must be a boolean");
      return { method: "set_paused", args: ["--paused", String(action.paused)] };
    case "allocate":
      return { method: "allocate", args: ["--amount", positiveInteger(action.amount)] };
    case "settle":
      return {
        method: "settle",
        args: ["--principal", positiveInteger(action.principal), "--returned", positiveInteger(action.returned)],
      };
    case "record-loss":
      return { method: "record_loss", args: ["--principal", positiveInteger(action.principal)] };
    case "set-allocation-limit":
      if (!Number.isInteger(action.allocationLimitBps) || action.allocationLimitBps < 1 || action.allocationLimitBps > 8000) {
        throw new Error("allocation limit must be 1..8000 basis points");
      }
      return { method: "set_allocation_limit", args: ["--allocation_limit_bps", String(action.allocationLimitBps)] };
    default:
      throw new Error("unsupported liquidity vault action");
  }
}

function positiveInteger(value: string): string {
  const normalized = nonnegativeInteger(value);
  if (normalized === "0") throw new Error("amount must be positive");
  return normalized;
}

function nonnegativeInteger(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("amount must be a nonnegative integer");
  const parsed = BigInt(value);
  if (parsed > (1n << 127n) - 1n) throw new Error("amount exceeds i128");
  return value;
}

function parseInteger(value: string): string {
  const raw = value.trim();
  const parsed = raw.startsWith('"') ? String(JSON.parse(raw)) : raw;
  if (!/^-?[0-9]+$/.test(parsed)) throw new Error("invalid vault integer response");
  return parsed;
}

function parseBoolean(value: string): boolean {
  const parsed = unquote(value);
  if (parsed === true || parsed === "true") return true;
  if (parsed === false || parsed === "false") return false;
  throw new Error("invalid vault boolean response");
}

function parseAddress(value: string): string {
  const parsed = String(unquote(value)).trim().toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(parsed) && !/^C[A-Z2-7]{55}$/.test(parsed)) {
    throw new Error("invalid Stellar address");
  }
  return parsed;
}

function unquote(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
