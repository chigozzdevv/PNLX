import { ownerCommitment } from "@pnlx/crypto";
import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import type { ClaimableRewardKind, PreparedRewardClaim, RewardBalance, RewardsAccount } from "@/features/rewards/rewards.model";
import { ReferralRegistry } from "@/features/rewards/rewards.referrals";
import { RewardAccrualService } from "@/features/rewards/rewards.accrual";
import { RewardRequestRegistry } from "@/features/rewards/rewards.requests";
import type { ProtocolStore } from "@/shared/state/store";

type RewardRelayer = Pick<RelayerService, "readAsync" | "prepareXdr">;

export class RewardsService {
  private readonly accrual: RewardAccrualService;

  constructor(
    private readonly relayer: RewardRelayer,
    private readonly store: ProtocolStore,
    private readonly referrals: ReferralRegistry,
    makerAddress?: string,
    private readonly deployment?: DeploymentRegistry,
    private readonly requests = new RewardRequestRegistry(),
  ) {
    this.accrual = new RewardAccrualService(store, makerAddress);
  }

  async account(owner: string): Promise<RewardsAccount> {
    const address = validAddress(owner);
    const contractId = this.deployment?.contracts["rewards-escrow"] ?? null;
    const ownerId = ownerCommitment(address);
    const calculated = this.accrual.forOwner(ownerId, await this.referrals.forReferrer(ownerId));
    const accrued = calculated.complete ? { rebate: calculated.rebate.toString(),
      referral: calculated.referral.toString() } : null;
    if (!contractId) return { contractId: null, rebate: null, referral: null, accrued };
    const [rebate, referral] = await Promise.all([this.balance(contractId, address, 0), this.balance(contractId, address, 1)]);
    const reconciled = accrued && BigInt(rebate.credited) <= calculated.rebate &&
      BigInt(referral.credited) <= calculated.referral ? accrued : null;
    if (reconciled) {
      await Promise.all((["rebate", "referral"] as const).map(async (kind) => {
        if (BigInt(reconciled[kind]) > BigInt((kind === "rebate" ? rebate : referral).credited)) {
          await this.requests.queue(contractId, address, kind);
        }
      }));
    }
    return { contractId, rebate, referral, accrued: reconciled };
  }

  registerReferral(owner: string, referrer: string) {
    return this.referrals.register(owner, referrer, this.store);
  }

  async prepareClaim(owner: string, kind: ClaimableRewardKind): Promise<PreparedRewardClaim> {
    const address = validAddress(owner);
    const contractId = this.deployment?.contracts["rewards-escrow"];
    if (!contractId) throw new Error("Reward claims are not available yet");
    const kindId = kind === "rebate" ? 0 : 1;
    if (BigInt(await this.read(contractId, "claimable", address, kindId)) <= 0n) {
      throw new Error("No reward is available to claim");
    }
    const prepared = this.relayer.prepareXdr({
      kind: "contract-invoke",
      payload: {
        args: ["--owner", address, "--kind", String(kindId)],
        buildOnly: true,
        contractId,
        functionName: "claim",
        send: "no",
        source: address,
      },
    });
    return { contractId, kind, owner: address, txHash: prepared.txHash, xdr: prepared.xdr };
  }

  private async balance(contractId: string, owner: string, kind: number): Promise<RewardBalance> {
    const [claimable, claimed, credited] = await Promise.all([
      this.read(contractId, "claimable", owner, kind),
      this.read(contractId, "claimed_total", owner, kind),
      this.read(contractId, "credited_total", owner, kind),
    ]);
    if (BigInt(claimable) + BigInt(claimed) !== BigInt(credited)) {
      throw new Error("Reward balance does not reconcile");
    }
    return { claimable, claimed, credited };
  }

  private async read(contractId: string, functionName: string, owner: string, kind: number): Promise<string> {
    const result = await this.relayer.readAsync({
      kind: "contract-invoke",
      payload: {
        args: ["--owner", owner, "--kind", String(kind)],
        contractId,
        functionName,
        send: "no",
      },
    });
    const value: unknown = JSON.parse(result.output.trim());
    if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid reward balance");
    const amount = String(value);
    if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new Error("Invalid reward balance");
    return amount;
  }
}

function validAddress(value: string): string {
  if (!/^G[A-Z2-7]{55}$/.test(value)) throw new Error("Invalid reward wallet address");
  return value;
}
