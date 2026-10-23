import { pnlxPost } from "@/lib/pnlx-api";
import { confirmPrivateMarginDeposit, privateMarginNotes, type StoredPrivateMarginNote } from "@/lib/private-margin-notes";
import type { WalletSession } from "@/lib/wallet-auth";
import type { Hex } from "@/types/trading";

interface ConfirmedDepositNote {
  commitment: Hex;
  marginRoot: Hex;
  membershipRoot: Hex;
  membershipProof: { indices: boolean[]; leaf: Hex; root: Hex; siblings: Hex[] };
  onchain: { relays: never[] };
  confirmedRecovery: { txHash: Hex; ledger: number };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function recoverWalletAssetDeposit(input: {
  commitment: Hex;
  expectedTxHash?: Hex;
  session: WalletSession;
}): Promise<ConfirmedDepositNote> {
  const { note } = await pnlxPost<{ note: ConfirmedDepositNote }>(
    "/notes/deposit-asset/recover-confirmed", { commitment: input.commitment }, input.session.token,
  );
  if (!note || !same(note.commitment, input.commitment) ||
      !/^0x[0-9a-f]{64}$/i.test(note.confirmedRecovery?.txHash ?? "") ||
      !Number.isSafeInteger(note.confirmedRecovery?.ledger) || note.confirmedRecovery.ledger <= 0 ||
      (input.expectedTxHash && !same(note.confirmedRecovery.txHash, input.expectedTxHash)) ||
      !same(note.membershipProof?.leaf ?? "", input.commitment) ||
      !same(note.membershipProof?.root ?? "", note.membershipRoot) ||
      !Array.isArray(note.onchain?.relays) || note.onchain.relays.length !== 0) {
    throw new Error("Confirmed deposit receipt does not match the pending note");
  }
  return note;
}

export async function recoverPendingPrivateMarginDeposits(session: WalletSession): Promise<number> {
  const pending = privateMarginNotes(session.ownerCommitment).filter((note) =>
    note.status === "pending" && !note.lockedByIntentCommitment && !note.claimSourceIntentCommitment &&
    note.walletAddress === session.address).slice(0, 16);
  let recovered = 0;
  for (const note of pending) {
    try {
      await recoverWalletAssetDeposit({ commitment: note.commitment, session });
      if (await confirmRecoveredPrivateMarginDeposit(note, session)) recovered += 1;
    } catch {
      // Unknown outcomes keep the saved opening pending for a later reconciliation.
    }
  }
  return recovered;
}

export async function confirmRecoveredPrivateMarginDeposit(note: StoredPrivateMarginNote, session: WalletSession): Promise<boolean> {
  if (!same(note.ownerCommitment, session.ownerCommitment) || note.walletAddress !== session.address) return false;
  const result = await pnlxPost<{ notes: Array<{
    commitment: Hex; known: boolean; spent: boolean; activeIntentCommitment?: Hex;
  }> }>("/notes/recovery-status", {
    notes: [{ commitment: note.commitment, nullifier: note.noteNullifier }],
  }, session.token);
  const status = result.notes.find((value) => same(value.commitment, note.commitment));
  return status?.known === true && status.spent === false && !status.activeIntentCommitment &&
    confirmPrivateMarginDeposit(note);
}
