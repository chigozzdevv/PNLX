"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { formatUsd } from "@/lib/format";
import type { PositionRow } from "@/types/trading";

interface PositionCloseDialogProps {
  closing?: boolean;
  onClose: () => void;
  onConfirm: (position: PositionRow) => Promise<void> | void;
  position: PositionRow | null;
}

export function PositionCloseDialog({ closing = false, onClose, onConfirm, position }: PositionCloseDialogProps) {
  useEffect(() => {
    if (!position) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !closing) onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closing, onClose, position]);

  if (!position) return null;

  const asset = position.market.split("/")[0] || "PERP";
  const unrealizedPnl = position.unrealizedPnl ?? 0;
  const estimatedReturn = Math.max(0, (position.collateral ?? 0) + unrealizedPnl);

  return (
    <div className="portfolio-close-overlay" role="presentation" onMouseDown={closing ? undefined : onClose}>
      <section
        aria-labelledby="close-position-title"
        aria-modal="true"
        className="portfolio-close-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="portfolio-dialog-header">
          <h2 id="close-position-title">Close position</h2>
          <button aria-label="Close" className="portfolio-dialog-close" disabled={closing} type="button" onClick={onClose}>
            <X aria-hidden="true" size={19} strokeWidth={2} />
          </button>
        </header>

        <div className="portfolio-close-market">
          <strong>{position.market} · {position.side === "short" ? "Short" : "Long"}</strong>
          <span>Entire position</span>
        </div>
        <div className="portfolio-close-summary">
          <CloseRow label="Size" value={typeof position.size === "number" ? `${formatFlexibleNumber(position.size)} ${asset}` : "—"} />
          <CloseRow label="Current mark" value={typeof position.marketPrice === "number" ? formatPrice(position.marketPrice) : "—"} />
          <CloseRow
            label="Estimated PnL"
            value={signedUsd(position.unrealizedPnl)}
            valueClass={unrealizedPnl > 0 ? "portfolio-value-positive" : unrealizedPnl < 0 ? "portfolio-value-negative" : undefined}
          />
          <CloseRow label="Estimated return" value={portfolioUsd(estimatedReturn)} />
        </div>
        <p className="portfolio-close-note">Final values use the verified mark price and funding state at settlement.</p>
        <div className="portfolio-close-actions">
          <button className="portfolio-dialog-cancel" disabled={closing} type="button" onClick={onClose}>Cancel</button>
          <button className="portfolio-primary-action" disabled={closing} type="button" onClick={() => onConfirm(position)}>
            {closing ? "Closing position" : "Close position"}
          </button>
        </div>
      </section>
    </div>
  );
}

function CloseRow({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={valueClass}>{value}</strong>
    </div>
  );
}

function signedUsd(value?: number): string {
  if (typeof value !== "number" || Math.abs(value) < Number.EPSILON) return portfolioUsd(0);
  return `${value > 0 ? "+" : "−"}${portfolioUsd(Math.abs(value))}`;
}

function formatPrice(value: number): string {
  return formatUsd(value, {
    maximumFractionDigits: value < 1 ? 5 : value < 100 ? 3 : 1,
    minimumFractionDigits: value < 1 ? 4 : value < 100 ? 2 : 0,
  });
}

function formatFlexibleNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
}

function portfolioUsd(value: number): string {
  return formatUsd(value, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
