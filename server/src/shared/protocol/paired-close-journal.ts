import type { AccountEventRecord, Hex, PairedPositionCloseRecord } from "@pnlx/protocol-types";
import type { StoredMakerNoteRecord } from "@/shared/maker-note-store";

export interface PendingPairedClose {
  journalKey: Hex;
  pair: PairedPositionCloseRecord;
  outputNotes: [StoredMakerNoteRecord, StoredMakerNoteRecord];
  conditional: boolean;
  createdAt: number;
  accountEvents?: [AccountEventRecord | undefined, AccountEventRecord | undefined];
  settlementTxHash?: Hex;
  preparedXdr?: string;
  retired?: boolean;
  retiredReason?: string;
  retiredReconciled?: boolean;
}
