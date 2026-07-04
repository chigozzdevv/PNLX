import { protocolUsdcToDisplay } from "@/lib/asset-units";
import {
  defaultClientProofProvider,
  registerProofBundle,
  type ClientProofProvider,
} from "@/lib/client-proof-provider";
import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import {
  markPrivateMarginNoteSpent,
  selectWithdrawablePrivateMarginNote,
} from "@/lib/private-margin-notes";
import type { Hex, ServerProofMeta } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

interface HealthResponse {
  custody: {
    collateralAsset: {
      tokenContract: string;
      tokenDigest?: Hex;
    };
  };
}

interface MarginMembershipResponse {
  note: {
    membershipProof: {
      indices: boolean[];
      root: Hex;
      siblings: Hex[];
    };
  };
}

interface WithdrawAssetResponse {
  withdrawal: {
    changeCommitment: Hex;
    nullifier: Hex;
    proof: ServerProofMeta;
    recipient: Hex;
    recipientAddress: string;
    root: Hex;
    token: string;
    tokenDigest: Hex;
    withdrawAmount: string;
  };
}

interface AddressDigestResponse {
  digest: Hex;
}

export interface WithdrawAvailableCollateralResult {
  amount: number;
  commitment: Hex;
  withdrawal: WithdrawAssetResponse["withdrawal"];
}

export async function withdrawAvailableCollateral(
  session: WalletSession,
  proofProvider: ClientProofProvider | undefined = defaultClientProofProvider(),
): Promise<WithdrawAvailableCollateralResult> {
  if (!proofProvider) {
    throw new Error("Client proof provider is not configured");
  }
  const health = await pnlxGet<HealthResponse>("/health", session.token);
  const token = health.custody.collateralAsset.tokenContract;
  const tokenDigest = health.custody.collateralAsset.tokenDigest;
  if (!token) throw new Error("Collateral token contract is not configured");
  if (!tokenDigest) throw new Error("Collateral token digest is not configured");

  const note = selectWithdrawablePrivateMarginNote({
    assetDigest: tokenDigest,
    ownerCommitment: session.ownerCommitment,
  });
  const membership = await marginMembership(note.commitment, session.token);
  const recipient = await addressDigest(session.address, session.token);
  const withdrawal = await registerProofBundle(
    await proofProvider.withdraw({
      assetDigest: note.assetDigest,
      blinding: note.blinding,
      changeBlinding: "0x0",
      changeRhoDigest: "0x0",
      noteAmount: BigInt(note.amount),
      noteCommitment: note.commitment,
      nullifier: note.noteNullifier,
      ownerDigest: note.ownerDigest,
      pathIndices: membership.membershipProof.indices,
      pathSiblings: membership.membershipProof.siblings,
      recipient,
      rhoDigest: note.rhoDigest,
      root: membership.membershipProof.root,
      spendSecretDigest: note.spendSecretDigest,
      tokenDigest: note.assetDigest,
      withdrawAmount: BigInt(note.amount),
    }),
    session.token,
  );
  const response = await pnlxPost<WithdrawAssetResponse>(
    "/notes/withdraw-asset/proven",
    {
      ...withdrawal,
      recipientAddress: session.address,
      token,
    },
    session.token,
  );
  markPrivateMarginNoteSpent(note.commitment);

  return {
    amount: protocolUsdcToDisplay(note.amount),
    commitment: note.commitment,
    withdrawal: response.withdrawal,
  };
}

async function marginMembership(commitment: Hex, token?: string): Promise<MarginMembershipResponse["note"]> {
  const response = await pnlxGet<MarginMembershipResponse>(
    `/notes/membership?commitment=${encodeURIComponent(commitment)}`,
    token,
  );
  return response.note;
}

async function addressDigest(address: string, token?: string): Promise<Hex> {
  const response = await pnlxGet<AddressDigestResponse>(
    `/notes/address-digest?address=${encodeURIComponent(address)}`,
    token,
  );
  return response.digest;
}
