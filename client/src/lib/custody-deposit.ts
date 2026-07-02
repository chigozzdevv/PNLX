import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import { createCircuitMarginNote, randomLabel, type CircuitMarginNote } from "@/lib/private-note";
import { signWalletTransaction, type WalletSession } from "@/lib/wallet-auth";
import type { Hex, ServerProofMeta } from "@/types/trading";
import {
  registerProofBundle,
  type ClientProofProvider,
  type DepositNoteProofRecord,
} from "@/lib/client-proof-provider";

interface HealthResponse {
  stellar: {
    network: string;
    networkPassphrase: string;
  };
}

interface RelayedTx {
  functionName?: string;
  kind: string;
  relayId: Hex;
  submitted: boolean;
  txHash?: Hex;
}

interface PreparedDepositAction {
  command: string[];
  contractId: string;
  functionName: "deposit_asset";
  kind: "deposit";
  xdr?: string;
}

interface DepositProof {
  amount: string;
  commitment: Hex;
  tokenDigest: Hex;
  proof: ServerProofMeta;
}

interface PendingDeposit {
  amount: string;
  commitment: Hex;
  from: string;
  preparedTxHash?: Hex;
  preparedXdrDigest: Hex;
  token: string;
  tokenDigest: Hex;
}

interface PrepareAssetDepositResponse {
  action: PreparedDepositAction;
  depositProof: DepositProof;
  pendingDeposit: PendingDeposit;
  proofVerification: {
    relays: RelayedTx[];
  };
}

interface FinalizeAssetDepositResponse {
  note: {
    commitment: Hex;
    marginRoot: Hex;
    membershipProof: {
      indices: boolean[];
      leaf: Hex;
      root: Hex;
      siblings: Hex[];
    };
    membershipRoot: Hex;
    onchain: {
      relays: RelayedTx[];
    };
  };
}

export interface PrepareWalletAssetDepositInput {
  amount: bigint;
  assetDigest?: Hex;
  assetId?: string;
  proofProvider?: ClientProofProvider;
  session: WalletSession;
  token: string;
}

export interface PreparedWalletAssetDeposit {
  note: CircuitMarginNote;
  prepared: PrepareAssetDepositResponse;
}

export async function prepareWalletAssetDeposit(
  input: PrepareWalletAssetDepositInput,
): Promise<PreparedWalletAssetDeposit> {
  const note = await createCircuitMarginNote({
    amount: input.amount,
    assetDigest: input.assetDigest,
    assetId: input.assetId ?? "usdc",
    blinding: randomLabel("custody-blind"),
    owner: input.session.address,
    rho: randomLabel("custody-rho"),
    spendSecret: randomLabel("custody-spend"),
  });
  const depositRequest = {
    amount: input.amount.toString(),
    blinding: note.blinding,
    commitment: note.commitment,
    from: input.session.address,
    ownerDigest: note.ownerDigest,
    rhoDigest: note.rhoDigest,
    token: input.token,
    tokenDigest: note.assetDigest,
  };
  const prepared = input.proofProvider
    ? await prepareProvenDeposit(input.proofProvider, depositRequest, input.session.token)
    : await pnlxPost<PrepareAssetDepositResponse>(
        "/notes/deposit-asset/prepare",
        depositRequest,
        input.session.token,
      );

  return { note, prepared };
}

async function prepareProvenDeposit(
  proofProvider: ClientProofProvider,
  request: {
    amount: string;
    blinding: Hex;
    commitment: Hex;
    from: string;
    ownerDigest: Hex;
    rhoDigest: Hex;
    token: string;
    tokenDigest: Hex;
  },
  token?: string,
): Promise<PrepareAssetDepositResponse> {
  const depositProof = await registerProofBundle(
    await proofProvider.depositNote({
      amount: BigInt(request.amount),
      blinding: request.blinding,
      commitment: request.commitment,
      ownerDigest: request.ownerDigest,
      rhoDigest: request.rhoDigest,
      tokenDigest: request.tokenDigest,
    }),
    token,
  );
  return pnlxPost<PrepareAssetDepositResponse>(
    "/notes/deposit-asset/prepare-proven",
    {
      amount: request.amount,
      commitment: request.commitment,
      depositProof: normalizeDepositProof(depositProof),
      from: request.from,
      token: request.token,
    },
    token,
  );
}

export async function signAndRelayPreparedDeposit(input: {
  prepared: PrepareAssetDepositResponse;
  session: WalletSession;
}): Promise<RelayedTx> {
  if (!input.prepared.action.xdr) {
    throw new Error("Prepared deposit action did not include wallet transaction xdr");
  }
  const health = await pnlxGet<HealthResponse>("/health", input.session.token);
  const signedXdr = await signWalletTransaction(input.prepared.action.xdr, {
    address: input.session.address,
    network: health.stellar.network,
    networkPassphrase: health.stellar.networkPassphrase,
  });
  const result = await pnlxPost<{ relay: RelayedTx }>(
    "/relays/signed-xdr",
    {
      commitment: input.prepared.pendingDeposit.commitment,
      expectedTxHash: input.prepared.pendingDeposit.preparedTxHash,
      preparedXdrDigest: input.prepared.pendingDeposit.preparedXdrDigest,
      xdr: signedXdr,
    },
    input.session.token,
  );
  return result.relay;
}

export async function finalizeWalletAssetDeposit(input: {
  prepared: PrepareAssetDepositResponse;
  relay: RelayedTx;
  session: WalletSession;
}): Promise<FinalizeAssetDepositResponse["note"]> {
  const result = await pnlxPost<FinalizeAssetDepositResponse>(
    "/notes/deposit-asset/finalize",
    {
      amount: input.prepared.depositProof.amount,
      commitment: input.prepared.depositProof.commitment,
      depositProof: input.prepared.depositProof,
      from: input.session.address,
      relayId: input.relay.relayId,
      token: input.prepared.pendingDeposit.token,
    },
    input.session.token,
  );
  return result.note;
}

export async function signRelayAndFinalizePreparedDeposit(input: {
  prepared: PrepareAssetDepositResponse;
  session: WalletSession;
}): Promise<FinalizeAssetDepositResponse["note"]> {
  const relay = await signAndRelayPreparedDeposit(input);
  return finalizeWalletAssetDeposit({ ...input, relay });
}

function normalizeDepositProof(proof: DepositNoteProofRecord): DepositProof {
  return {
    amount: proof.amount,
    commitment: proof.commitment,
    proof: proof.proof,
    tokenDigest: proof.tokenDigest,
  };
}
