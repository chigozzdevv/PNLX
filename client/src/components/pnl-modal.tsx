import { CheckCircle, ExternalLink } from "lucide-react";
import { formatNumber, formatUsd } from "@/lib/format";

export interface PnlModalProps {
  closePrice: number;
  entryPrice: number;
  fee: number;
  fundingPayment: number;
  grossPricePnl: number;
  initialMargin: number;
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
  initialMargin,
  isOpen,
  marketId,
  onClose,
  returnedMargin,
  side,
  size,
  txHash,
}: PnlModalProps) {
  if (!isOpen) return null;

  const pairName = `${marketId.split("-")[0]?.toUpperCase() || "PERP"}/USD`;
  const fundingImpact = -fundingPayment;
  const feeImpact = -fee;
  const netRealizedPnl = grossPricePnl + fundingImpact + feeImpact;
  const isPositive = netRealizedPnl >= 0;

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
            <h3>{pairName} {side === "long" ? "Long" : "Short"}</h3>
            <span className="pnl-modal-market-size">{formatNumber(size, 6)} {pairName.split("/")[0]}</span>
          </div>

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

          <div className="pnl-modal-pnl-section">
            <span className="pnl-modal-pnl-label">Net realized PnL</span>
            <span className={`pnl-modal-pnl-val ${isPositive ? "pnl-positive" : "pnl-negative"}`}>
              {signedUsd(netRealizedPnl)}
            </span>
          </div>

          <div className="pnl-modal-row">
            <span className="pnl-modal-label">Initial margin</span>
            <span className="pnl-modal-value">{formatUsd(initialMargin)}</span>
          </div>
          <div className="pnl-modal-row pnl-modal-returned-margin">
            <span className="pnl-modal-label">Returned margin</span>
            <span className="pnl-modal-value text-white">{formatUsd(returnedMargin)} USDC</span>
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
          <button className="pnl-modal-btn-done" onClick={onClose} type="button">Done</button>
        </div>
      </div>
    </div>
  );
}

function SettlementRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="pnl-modal-row">
      <span className="pnl-modal-label">{label}</span>
      <span className={`pnl-modal-value ${value >= 0 ? "metric-positive" : "metric-negative"}`}>
        {signedUsd(value)}
      </span>
    </div>
  );
}

function signedUsd(value: number): string {
  if (Math.abs(value) < Number.EPSILON) return formatUsd(0);
  return `${value > 0 ? "+" : "−"}${formatUsd(Math.abs(value))}`;
}
