import { CheckCircle, ExternalLink } from "lucide-react";
import { formatUsd } from "@/lib/format";

export interface PnlModalProps {
  isOpen: boolean;
  onClose: () => void;
  marketId: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  closePrice: number;
  pnl: number;
  collateral: number;
  txHash?: string;
}

export function PnlModal({
  isOpen,
  onClose,
  marketId,
  side,
  size,
  entryPrice,
  closePrice,
  pnl,
  collateral,
  txHash,
}: PnlModalProps) {
  if (!isOpen) return null;

  const pairName = `${marketId.split("-")[0]?.toUpperCase() || "PERP"}/USD`;
  const isPositive = pnl >= 0;
  const pnlSign = isPositive ? "+" : "";

  return (
    <div className="pnl-modal-overlay">
      <div className="pnl-modal-container">
        <div className="pnl-modal-header">
          <div className="pnl-modal-title">
            <span>Position Closed</span>
            <CheckCircle className="pnl-modal-icon-success" size={20} />
          </div>
        </div>

        <div className="pnl-modal-body">
          <div className="pnl-modal-market">
            <h3>
              {pairName} {side === "long" ? "Long" : "Short"}
            </h3>
            <span className="pnl-modal-market-size">Size: {size}</span>
          </div>

          <div className="pnl-modal-row">
            <span className="pnl-modal-label">Entry Price</span>
            <span className="pnl-modal-value">${entryPrice.toFixed(4)}</span>
          </div>
          <div className="pnl-modal-row">
            <span className="pnl-modal-label">Close Price</span>
            <span className="pnl-modal-value">${closePrice.toFixed(4)}</span>
          </div>

          <div className="pnl-modal-divider" />

          <div className="pnl-modal-pnl-section">
            <span className="pnl-modal-pnl-label">PnL</span>
            <span className={`pnl-modal-pnl-val ${isPositive ? "pnl-positive" : "pnl-negative"}`}>
              {pnlSign}
              {formatUsd(pnl)} USDC
            </span>
          </div>

          <div className="pnl-modal-row">
            <span className="pnl-modal-label">Payout Collateral</span>
            <span className="pnl-modal-value text-white">{formatUsd(collateral)} USDC</span>
          </div>

          <div className="pnl-modal-divider" />

          {txHash ? (
            <div className="pnl-modal-row">
              <span className="pnl-modal-label">Transaction</span>
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
          ) : null}
        </div>

        <div className="pnl-modal-footer">
          <button className="pnl-modal-btn-done" onClick={onClose} type="button">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
