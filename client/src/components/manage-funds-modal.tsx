"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatUsd, shortAddress } from "@/lib/format";
import type { Hex } from "@/types/trading";

export interface ManageFundsBalance {
  amount: number;
  commitment: Hex;
  createdAt: number;
}

interface ManageFundsModalProps {
  address: string;
  available: number;
  depositing?: boolean;
  isOpen: boolean;
  message?: { tone: "error" | "success"; text: string };
  notes: ManageFundsBalance[];
  onClose: () => void;
  onDeposit: (amount: number) => Promise<void> | void;
  onSelect: (commitment: Hex) => void;
  onWithdraw: (commitment: Hex) => Promise<void> | void;
  selectedCommitment?: Hex;
  withdrawing?: boolean;
}

export function ManageFundsModal({
  address,
  available,
  depositing = false,
  isOpen,
  message,
  notes,
  onClose,
  onDeposit,
  onSelect,
  onWithdraw,
  selectedCommitment,
  withdrawing = false,
}: ManageFundsModalProps) {
  const [view, setView] = useState<"deposit" | "withdraw">("deposit");
  const [depositAmount, setDepositAmount] = useState("");
  const busy = depositing || withdrawing;
  const selected = notes.find((note) => note.commitment === selectedCommitment) ?? notes[0];
  const parsedDepositAmount = Number(depositAmount);

  useEffect(() => {
    if (!isOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="portfolio-funds-overlay"
      role="presentation"
      onMouseDown={busy ? undefined : onClose}
    >
      <section
        aria-labelledby="manage-funds-title"
        aria-modal="true"
        className="portfolio-funds-drawer"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="portfolio-dialog-header">
          <h2 id="manage-funds-title">Manage funds</h2>
          <button aria-label="Close" className="portfolio-dialog-close" disabled={busy} type="button" onClick={onClose}>
            <X aria-hidden="true" size={19} strokeWidth={2} />
          </button>
        </header>

        <div className="portfolio-dialog-tabs" role="tablist" aria-label="Fund action">
          <button aria-selected={view === "deposit"} role="tab" type="button" onClick={() => setView("deposit")}>Deposit</button>
          <button aria-selected={view === "withdraw"} role="tab" type="button" onClick={() => setView("withdraw")}>Withdraw</button>
        </div>

        {view === "deposit" ? (
          <div className="portfolio-fund-panel">
            <label className="portfolio-fund-field">
              <span>Amount</span>
              <div className="portfolio-amount-input">
                <input
                  aria-label="Deposit amount"
                  disabled={busy}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={depositAmount}
                  onChange={(event) => setDepositAmount(event.target.value)}
                />
                <strong>USDC</strong>
              </div>
            </label>
            <div className="portfolio-fund-destination">
              <span>Destination</span>
              <strong>PNLX balance</strong>
            </div>
            <button
              className="portfolio-primary-action portfolio-fund-submit"
              disabled={busy || !Number.isFinite(parsedDepositAmount) || parsedDepositAmount <= 0}
              type="button"
              onClick={() => onDeposit(parsedDepositAmount)}
            >
              {depositing ? "Depositing" : "Deposit USDC"}
            </button>
            {message ? <FundMessage message={message} /> : null}
            <p className="portfolio-fund-helper">Deposited USDC becomes available for margin.</p>
          </div>
        ) : (
          <div className="portfolio-fund-panel">
            <div className="portfolio-fund-balance">
              <span>Available to withdraw</span>
              <strong>{portfolioUsd(available)}</strong>
            </div>
            <label className="portfolio-fund-field">
              <span>Private balance</span>
              <select
                aria-label="Private balance"
                disabled={busy || notes.length === 0}
                value={selected?.commitment ?? ""}
                onChange={(event) => onSelect(event.target.value as Hex)}
              >
                {notes.length === 0 ? <option value="">No available balance</option> : null}
                {notes.map((note) => (
                  <option key={note.commitment} value={note.commitment}>
                    {portfolioUsd(note.amount)} USDC · {formatDate(note.createdAt)}
                  </option>
                ))}
              </select>
            </label>
            <div className="portfolio-fund-destination">
              <span>You will receive</span>
              <strong>{selected ? `${portfolioUsd(selected.amount)} USDC` : "—"}</strong>
            </div>
            <div className="portfolio-fund-destination">
              <span>Destination</span>
              <strong>{shortAddress(address)}</strong>
            </div>
            <button
              className="portfolio-primary-action portfolio-fund-submit"
              disabled={busy || !selected}
              type="button"
              onClick={() => selected && onWithdraw(selected.commitment)}
            >
              {withdrawing ? "Withdrawing" : selected ? `Withdraw ${portfolioUsd(selected.amount)}` : "Withdraw"}
            </button>
            {message ? <FundMessage message={message} /> : null}
            <p className="portfolio-fund-helper">The selected private balance will be withdrawn in full.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function FundMessage({ message }: { message: { tone: "error" | "success"; text: string } }) {
  return <p className={`portfolio-fund-message portfolio-fund-message-${message.tone}`}>{message.text}</p>;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(new Date(timestamp));
}

function portfolioUsd(value: number): string {
  return formatUsd(value, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
