import { defaultClientProofProvider, registerProofBundle, type ClientProofProvider, type DepositNoteProofRecord } from "@/lib/client-proof-provider";
import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import { createCircuitMarginNote, randomLabel } from "@/lib/private-note";
import { backUpPrivateMarginNote } from "@/lib/private-note-backup";
import {
  privateMarginNotes,
  finalizePrivateMarginClaim,
  privateMarginNoteRuntimeScopeFromHealth,
  savePrivateMarginNote,
  setPrivateMarginNoteRuntimeScope,
  type PrivateMarginNoteRuntimeHealth,
  type StoredPrivateMarginNote,
} from "@/lib/private-margin-notes";
import type { WalletSession } from "@/lib/wallet-auth";
import type { Hex, ServerOwnerOrderSnapshot } from "@/types/trading";

interface ResidualClaimDetails {
  amount: string;
  claimedCommitment?: Hex;
  tokenDigest: Hex;
}

interface ClaimedResidual {
  amount: string;
  commitment: Hex;
}

export async function recoverCancelledResiduals(input: {
  cancelledIntentCommitments: Hex[];
  orders: ServerOwnerOrderSnapshot[];
  session: WalletSession;
}): Promise<number> {
  const cancelled = new Set(input.cancelledIntentCommitments.map((id) => id.toLowerCase()));
  const residuals = input.orders.filter((order) =>
    order.isResidual && (order.status === "cancelled" || cancelled.has(order.intentCommitment.toLowerCase())));
  let recovered = 0;
  for (const residual of residuals) {
    try {
      if (await recoverResidualClaim({ intentCommitment: residual.intentCommitment, session: input.session })) {
        recovered += 1;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Recovery failed";
      throw new Error(`Order cancelled. Collateral recovery is pending; use Recover in Orders. ${reason}`);
    }
  }
  return recovered;
}

export async function recoverResidualClaim(input: {
  backUpNote?: typeof backUpPrivateMarginNote;
  intentCommitment: Hex;
  proofProvider?: ClientProofProvider;
  session: WalletSession;
}): Promise<StoredPrivateMarginNote | undefined> {
  const health = await pnlxGet<PrivateMarginNoteRuntimeHealth>("/health", input.session.token);
  setPrivateMarginNoteRuntimeScope(privateMarginNoteRuntimeScopeFromHealth(health));
  const { intentCommitment, session } = input;
  const details = await pnlxPost<ResidualClaimDetails>(
    "/orders/residual-claim", { intentCommitment }, session.token,
  );
  const liveAmount = BigInt(details.amount);
  const candidates = privateMarginNotes(session.ownerCommitment).filter(
    (note) => note.claimSourceIntentCommitment?.toLowerCase() === intentCommitment.toLowerCase(),
  );
  const existing = details.claimedCommitment
    ? candidates.find((note) => note.commitment.toLowerCase() === details.claimedCommitment?.toLowerCase())
    : candidates.find((note) => note.status === "claiming");

  if (details.claimedCommitment) {
    if (!existing || existing.commitment.toLowerCase() !== details.claimedCommitment.toLowerCase()) {
      throw new Error("This residual was claimed to a note that is unavailable in this browser. Restore its note backup before using the funds.");
    }
  }
  if (!details.claimedCommitment && liveAmount <= 0n) return undefined;
  const amount = details.claimedCommitment && existing ? BigInt(existing.amount) : liveAmount;
  if (existing && (BigInt(existing.amount) !== amount || existing.assetDigest.toLowerCase() !== details.tokenDigest.toLowerCase())) {
    throw new Error("The saved recovery note does not match the on-chain residual");
  }

  const note = existing ?? await makeClaimingNote(amount, details.tokenDigest, input);
  await (input.backUpNote ?? backUpPrivateMarginNote)(note, session);
  const provider = input.proofProvider ?? defaultClientProofProvider();
  if (!provider) throw new Error("Client proof provider is not configured");
  const depositProof = await registerProofBundle(
    await provider.depositNote({
      amount,
      blinding: note.blinding,
      commitment: note.commitment,
      ownerDigest: note.ownerDigest,
      rhoDigest: note.rhoDigest,
      tokenDigest: note.assetDigest,
    }),
    session.token,
  );
  assertDepositProof(depositProof, note);
  const claimed = await pnlxPost<ClaimedResidual>(
    "/orders/claim-residual", { intentCommitment, depositProof }, session.token,
  );
  if (claimed.commitment.toLowerCase() !== note.commitment.toLowerCase() || BigInt(claimed.amount) !== amount) {
    throw new Error("Recovery confirmation does not match the saved private note");
  }
  return finalizePrivateMarginClaim(intentCommitment, note.commitment, session.ownerCommitment);
}

async function makeClaimingNote(
  amount: bigint,
  assetDigest: Hex,
  input: { intentCommitment: Hex; session: WalletSession },
): Promise<StoredPrivateMarginNote> {
  const circuitNote = await createCircuitMarginNote({
    amount,
    assetDigest,
    blinding: randomLabel("residual-blind"),
    owner: input.session.address,
    rho: randomLabel("residual-rho"),
    spendSecret: randomLabel("residual-spend"),
  });
  return savePrivateMarginNote({
    ...circuitNote,
    amount: amount.toString(),
    claimSourceIntentCommitment: input.intentCommitment,
    ownerCommitment: input.session.ownerCommitment,
    status: "claiming",
    walletAddress: input.session.address,
  });
}

function assertDepositProof(record: DepositNoteProofRecord, note: StoredPrivateMarginNote): void {
  if (
    record.amount !== note.amount ||
    record.commitment.toLowerCase() !== note.commitment.toLowerCase() ||
    record.tokenDigest.toLowerCase() !== note.assetDigest.toLowerCase()
  ) {
    throw new Error("Recovery proof does not match the saved private note");
  }
}
