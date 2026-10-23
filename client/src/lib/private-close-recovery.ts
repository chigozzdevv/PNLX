import type { LegacyExitReceiptBinding, PrivateAccountEventPayload } from "@/lib/account-encryption";
import { digestToFieldHex } from "@/lib/private-note";
import { currentPrivateMarginNoteRuntimeScope, privateMarginNotes, savePrivateMarginNote } from "@/lib/private-margin-notes";
import type { WalletSession } from "@/lib/wallet-auth";
import type { Hex } from "@/types/trading";
import { secureMarginCommitment, secureMarginNullifier } from "@pnlx/crypto/secure-margin-commitment";
import { pnlxPost } from "@/lib/pnlx-api";

export async function restorePrivateCloseOutputNote(
  session: WalletSession,
  payload: PrivateAccountEventPayload,
  eventOwnerCommitment: Hex,
): Promise<boolean> {
  if ((payload.kind !== "position-close" && payload.kind !== "liquidation" && payload.kind !== "legacy-position-close") || !payload.closeOutputNote) return false;
  if (eventOwnerCommitment.toLowerCase() !== session.ownerCommitment.toLowerCase()) throw new Error("Close output event owner mismatch");
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Private note runtime scope is unavailable");
  const note = payload.closeOutputNote;
  if (!/^[0-9]+$/.test(note.amount) || BigInt(note.amount) >= (1n << 128n)) throw new Error("Invalid close output amount");
  if (BigInt(note.amount) === 0n) return false;
  const legacyExit = payload.kind === "legacy-position-close" ? validatedLegacyExit(payload.legacyExit) : undefined;
  if (payload.kind === "legacy-position-close" && legacyExit && (payload.positionClose?.closeCommitment?.toLowerCase() !== legacyExit.closeCommitment.toLowerCase() ||
      !/^0x[0-9a-f]{64}$/i.test(payload.positionClose?.positionCommitment ?? "") ||
      !/^0x[0-9a-f]{64}$/i.test(payload.positionClose?.positionNullifier ?? ""))) {
    throw new Error("Legacy close source does not match its helper receipt");
  }
  const walletOwner = await digestToFieldHex(`owner:${session.address}`);
  const legacyWalletOwner = await digestToFieldHex(`owner:${session.ownerCommitment}`);
  // A funded legacy note retains its wallet binding when reused by a V2 position.
  const expectedOwners = legacyExit ? [legacyWalletOwner] : [walletOwner, legacyWalletOwner];
  if (!expectedOwners.some(owner => owner.toLowerCase() === note.ownerDigest.toLowerCase())) throw new Error("Close output note owner mismatch");
  const amount = BigInt(note.amount);
  const commitment = secureMarginCommitment({ ...note, amount });
  const nullifier = secureMarginNullifier(note);
  if (commitment.toLowerCase() !== note.commitment.toLowerCase() ||
      nullifier.toLowerCase() !== note.noteNullifier.toLowerCase() ||
      payload.positionClose?.marginOutputCommitment.toLowerCase() !== commitment.toLowerCase()) {
    throw new Error("Close output note does not match the settled commitment");
  }
  if (currentPrivateMarginNoteRuntimeScope() !== scope) throw new Error("Private note runtime changed during close recovery");
  const existing = privateMarginNotes(session.ownerCommitment).find((candidate) => candidate.commitment.toLowerCase() === commitment.toLowerCase());
  if (existing && existing.status !== "pending") return false;
  const response = await pnlxPost<{ notes: Array<{
    commitment: Hex; known: boolean; spent: boolean; activeIntentCommitment?: Hex;
    legacyExit?: LegacyExitReceiptBinding & { confirmed: boolean; positionCommitment: Hex; positionNullifier: Hex };
  }> }>("/notes/recovery-status", { notes: [{ commitment, nullifier, ...(legacyExit ? { legacyExit } : {}) }] }, session.token);
  const status = response?.notes?.find((candidate) =>
    typeof candidate.commitment === "string" && candidate.commitment.toLowerCase() === commitment.toLowerCase());
  if (!status || typeof status.known !== "boolean" || typeof status.spent !== "boolean" ||
      (status.activeIntentCommitment !== undefined && !/^0x[0-9a-f]+$/i.test(status.activeIntentCommitment))) {
    throw new Error("Close output spend status is unavailable");
  }
  if (!status.known) return false;
  if (legacyExit && (!status.legacyExit || status.legacyExit.confirmed !== true ||
      status.legacyExit.helperContractId !== legacyExit.helperContractId ||
      status.legacyExit.transactionHash?.toLowerCase() !== legacyExit.transactionHash.toLowerCase() ||
      status.legacyExit.closeCommitment?.toLowerCase() !== legacyExit.closeCommitment.toLowerCase() ||
      status.legacyExit.outputIndex !== legacyExit.outputIndex ||
      status.legacyExit.positionCommitment?.toLowerCase() !== payload.positionClose?.positionCommitment.toLowerCase() ||
      status.legacyExit.positionNullifier?.toLowerCase() !== payload.positionClose?.positionNullifier.toLowerCase())) {
    throw new Error("Legacy close helper confirmation is unavailable or mismatched");
  }
  if (currentPrivateMarginNoteRuntimeScope() !== scope) throw new Error("Private note runtime changed during close recovery");
  const current = privateMarginNotes(session.ownerCommitment).find((candidate) => candidate.commitment.toLowerCase() === commitment.toLowerCase());
  if (current && current.status !== "pending") return false;
  savePrivateMarginNote({ ...note, amount: amount.toString(), noteFormat: "secure", ownerCommitment: session.ownerCommitment,
    runtimeScope: scope, status: status.spent ? "spent" : status.activeIntentCommitment ? "locked" : "available",
    lockedByIntentCommitment: status.spent ? undefined : status.activeIntentCommitment, walletAddress: session.address });
  return !status.spent;
}

function validatedLegacyExit(value: LegacyExitReceiptBinding): LegacyExitReceiptBinding {
  if (!value || typeof value !== "object" || !/^C[A-Z2-7]{55}$/.test(value.helperContractId) ||
      !/^0x[0-9a-f]{64}$/i.test(value.transactionHash) || !/^0x[0-9a-f]{64}$/i.test(value.closeCommitment) ||
      (value.outputIndex !== 0 && value.outputIndex !== 1)) throw new Error("Invalid legacy close helper receipt");
  return value;
}
