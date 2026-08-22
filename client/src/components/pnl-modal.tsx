"use client";

import { useEffect, useRef } from "react";
import { CheckCircle, ExternalLink } from "lucide-react";
import {
  formatNumber,
  formatSignedSettlementUsd,
  formatUsd,
  formatUsdc,
  settlementAmountSign,
} from "@/lib/format";

export interface PnlModalProps {
  closePrice: number;
  entryPrice: number;
  fee: number;
  fundingPayment: number;
  grossPricePnl: number;
  isOpen: boolean;
  marketId: string;
  onClose: () => void;
  returnedMargin: number;
  side: "long" | "short";
  size: number;
  txHash?: string;
}

export function PnlModal({
  closePrice,
  entryPrice,
  fee,
  fundingPayment,
  grossPricePnl,
  isOpen,
  marketId,
  onClose,
  returnedMargin,
  side,
  size,
  txHash,
}: PnlModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const doneButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const focusFrame = requestAnimationFrame(() => doneButtonRef.current?.focus());

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const focusIsOutside = !dialogRef.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const pairName = `${marketId.split("-")[0]?.toUpperCase() || "PERP"}/USD`;
  const fundingImpact = -fundingPayment;
  const feeImpact = -fee;
  const netRealizedPnl = grossPricePnl + fundingImpact + feeImpact;
  const netPnlSign = settlementAmountSign(netRealizedPnl);

  return (
    <div className="pnl-modal-overlay">
      <div
        aria-labelledby="pnl-modal-title"
        aria-modal="true"
        className="pnl-modal-container"
        ref={dialogRef}
        role="dialog"
      >
        <div className="pnl-modal-header">
          <h2 className="pnl-modal-title" id="pnl-modal-title">
            <CheckCircle aria-hidden="true" className="pnl-modal-icon-success" size={20} />
            <span>Position closed</span>
          </h2>
        </div>

        <div className="pnl-modal-body">
          <div className="pnl-modal-market">
            <div className="pnl-modal-market-identity">
              <h3>{pairName}</h3>
              <span className={`pnl-modal-side pnl-modal-side-${side}`}>
                {side === "long" ? "Long" : "Short"}
              </span>
            </div>
            <span className="pnl-modal-market-size">{formatNumber(size, 6)} {pairName.split("/")[0]}</span>
          </div>

          <div className="pnl-modal-pnl-section">
            <span className="pnl-modal-pnl-label">Net realized PnL</span>
            <span className={`pnl-modal-pnl-val ${valueClass(netPnlSign)}`}>
              {formatSignedSettlementUsd(netRealizedPnl)}
            </span>
          </div>

          <div className="pnl-modal-breakdown">
            <span className="pnl-modal-section-label">Settlement breakdown</span>
            <div className="pnl-modal-row">
              <span className="pnl-modal-label">Entry price</span>
              <span className="pnl-modal-value">{formatUsd(entryPrice, { maximumFractionDigits: 5 })}</span>
            </div>
            <div className="pnl-modal-row">
              <span className="pnl-modal-label">Close mark price</span>
              <span className="pnl-modal-value">{formatUsd(closePrice, { maximumFractionDigits: 5 })}</span>
            </div>
            <div className="pnl-modal-divider" />
            <SettlementRow label="Gross price PnL" value={grossPricePnl} />
            <SettlementRow label="Funding impact" value={fundingImpact} />
            <SettlementRow label="Close fee" value={feeImpact} />
          </div>

          <div className="pnl-modal-row pnl-modal-returned-margin">
            <span className="pnl-modal-label">Returned margin</span>
            <span className="pnl-modal-returned-value">
              {formatUsdc(returnedMargin)} <small>USDC</small>
            </span>
          </div>

          {txHash ? (
            <>
              <div className="pnl-modal-divider" />
              <div className="pnl-modal-row">
                <span className="pnl-modal-label">Settlement transaction</span>
                <a
                  href={`https://stellar.expert/explorer/testnet/tx/${txHash.replace(/^0x/, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pnl-modal-link"
                >
                  <span>txn_{txHash.slice(0, 6)}...{txHash.slice(-6)}</span>
                  <ExternalLink size={14} />
                </a>
              </div>
            </>
          ) : null}
        </div>

        <div className="pnl-modal-footer">
          <button
            className="pnl-modal-btn-done"
            onClick={onClose}
            ref={doneButtonRef}
            type="button"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function SettlementRow({ label, value }: { label: string; value: number }) {
  const sign = settlementAmountSign(value);
  return (
    <div className="pnl-modal-row">
      <span className="pnl-modal-label">{label}</span>
      <span className={`pnl-modal-value ${valueClass(sign, "metric")}`}>
        {formatSignedSettlementUsd(value)}
      </span>
    </div>
  );
}

function valueClass(sign: -1 | 0 | 1, prefix = "pnl"): string {
  if (sign > 0) return `${prefix}-positive`;
  if (sign < 0) return `${prefix}-negative`;
  return "";
}
