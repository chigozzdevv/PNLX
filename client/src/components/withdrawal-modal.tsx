import { formatUsd, shortAddress } from "@/lib/format";
import type { Hex } from "@/types/trading";

export interface WithdrawableNote {
  amount: number;
  commitment: Hex;
}

interface WithdrawalModalProps {
  isOpen: boolean;
  notes: WithdrawableNote[];
  onClose: () => void;
  onConfirm: (commitment: Hex) => Promise<void> | void;
  onSelect: (commitment: Hex) => void;
  selectedCommitment?: Hex;
  withdrawing?: boolean;
}

export function WithdrawalModal({
  isOpen,
  notes,
  onClose,
  onConfirm,
  onSelect,
  selectedCommitment,
  withdrawing = false,
}: WithdrawalModalProps) {
  if (!isOpen) return null;

  const selected = notes.find((note) => note.commitment === selectedCommitment) ?? notes[0];

  return (
    <div className="pnl-modal-overlay" role="presentation" onMouseDown={withdrawing ? undefined : onClose}>
      <section
        aria-labelledby="withdrawal-title"
        aria-modal="true"
        className="pnl-modal-container withdrawal-modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="pnl-modal-header">
          <div className="pnl-modal-title" id="withdrawal-title">Withdraw</div>
        </header>

        <div className="withdrawal-note-list" role="group" aria-label="Available private notes">
          {notes.map((note) => {
            const active = note.commitment === selected?.commitment;
            return (
              <button
                aria-pressed={active}
                className={`withdrawal-note ${active ? "withdrawal-note-selected" : ""}`}
                disabled={withdrawing}
                key={note.commitment}
                type="button"
                onClick={() => onSelect(note.commitment)}
              >
                <span>
                  <strong>{formatUsd(note.amount)}</strong>
                  <small>USDC</small>
                </span>
                <small title={note.commitment}>{shortAddress(note.commitment)}</small>
              </button>
            );
          })}
        </div>

        <footer className="withdrawal-modal-actions">
          <button className="withdrawal-cancel-button" disabled={withdrawing} type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="withdrawal-confirm-button"
            disabled={!selected || withdrawing}
            type="button"
            onClick={() => selected && onConfirm(selected.commitment)}
          >
            {withdrawing ? "Withdrawing" : "Withdraw"}
          </button>
        </footer>
      </section>
    </div>
  );
}
