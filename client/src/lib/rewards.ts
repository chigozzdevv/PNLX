import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import { signWalletTransaction, type WalletSession } from "@/lib/wallet-auth";

export type RewardKind = "rebate" | "referral";

export interface RewardBalance {
  claimable: string;
  claimed: string;
  credited: string;
}

export interface RewardsAccount {
  contractId: string | null;
  rebate: RewardBalance | null;
  referral: RewardBalance | null;
  accrued: { rebate: string; referral: string } | null;
}

export async function getRewards(session: WalletSession): Promise<RewardsAccount> {
  const response = await pnlxGet<{ rewards: RewardsAccount }>("/rewards", session.token);
  return response.rewards;
}

export async function claimReward(session: WalletSession, kind: RewardKind, contractId: string): Promise<string> {
  const [prepared, health] = await Promise.all([
    pnlxPost<{ transaction: { contractId: string; kind: RewardKind; owner: string; txHash?: string; xdr: string } }>(
      "/rewards/prepare-claim", { kind }, session.token,
    ),
    pnlxGet<{ stellar: { network: string; networkPassphrase: string } }>("/health", session.token),
  ]);
  const transaction = prepared.transaction;
  if (transaction.owner !== session.address || transaction.kind !== kind || transaction.contractId !== contractId) {
    throw new Error("Prepared reward claim does not match your wallet");
  }
  const xdr = await signWalletTransaction(transaction.xdr, {
    address: session.address,
    network: health.stellar.network,
    networkPassphrase: health.stellar.networkPassphrase,
  });
  const result = await pnlxPost<{ relay: { submitted: boolean; txHash?: string } }>(
    "/relays/signed-xdr", { expectedTxHash: transaction.txHash, xdr }, session.token,
  );
  if (!result.relay.submitted || !result.relay.txHash) throw new Error("Reward claim was not confirmed");
  return result.relay.txHash;
}
