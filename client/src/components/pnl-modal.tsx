"use client";

import { useEffect, useRef, useState } from "react";
import { Share } from "lucide-react";
import {
  formatNumber,
  formatPct,
  formatSignedSettlementUsd,
  settlementAmountSign,
} from "@/lib/format";
import { createPnlShareCardFile } from "@/lib/pnl-share-card";

export interface PnlModalProps {
  closePrice: number;
  entryPrice: number;
  fee: number;
  fundingPayment: number;
  grossPricePnl: number;
  initialMargin?: number;
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
  side,
  txHash,
}: PnlModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const [shareStatus, setShareStatus] = useState<"idle" | "sharing" | "shared" | "copied" | "downloaded">("idle");

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (shareStatus !== "shared" && shareStatus !== "copied" && shareStatus !== "downloaded") return;
    const clearStatus = window.setTimeout(() => setShareStatus("idle"), 2_400);
    return () => window.clearTimeout(clearStatus);
  }, [shareStatus]);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const focusFrame = requestAnimationFrame(() => shareButtonRef.current?.focus({ preventScroll: true }));

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setShareStatus("idle");
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
  const pnlPercent = initialMargin && initialMargin > 0 ? (netRealizedPnl / initialMargin) * 100 : undefined;
  const txUrl = txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash.replace(/^0x/, "")}` : undefined;
  const compactTxHash = txHash
    ? `${txHash.replace(/^0x/, "").slice(0, 4)}...${txHash.slice(-4)}`.toUpperCase()
    : undefined;
  async function handleShare() {
    setShareStatus("sharing");
    try {
      const imageFile = await createPnlShareCardFile({
        closePrice,
        entryPrice,
        marketId,
        netRealizedPnl,
        pnlPercent,
        side,
        txHash,
      });

      if (
        typeof navigator.share === "function"
        && typeof navigator.canShare === "function"
        && navigator.canShare({ files: [imageFile] })
      ) {
        try {
          await navigator.share({
            files: [imageFile],
            title: `PNLX ${pairName} PNL`,
          });
          setShareStatus("shared");
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            setShareStatus("idle");
            return;
          }
        }
      }

      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": imageFile }),
        ]);
        setShareStatus("copied");
        return;
      }

      const imageUrl = URL.createObjectURL(imageFile);
      const download = document.createElement("a");
      download.download = imageFile.name;
      download.href = imageUrl;
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(imageUrl), 0);
      setShareStatus("downloaded");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setShareStatus("idle");
        return;
      }
      setShareStatus("idle");
    }
  }

  return (
    <div
      className="pnl-modal-overlay"
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        setShareStatus("idle");
        onClose();
      }}
    >
      <div
        aria-label={`${pairName} PNL result`}
        aria-modal="true"
        className="pnl-modal-container"
        ref={dialogRef}
        role="dialog"
      >
        <div className="pnl-modal-header">
          <div className="pnl-modal-header-row">
            <button
              aria-label="Share PNL card"
              className="pnl-modal-share"
              disabled={shareStatus === "sharing"}
              onClick={handleShare}
              ref={shareButtonRef}
              type="button"
            >
              <Share aria-hidden="true" size={20} />
            </button>
          </div>
        </div>

        <div className="pnl-modal-body">
          <div className="pnl-modal-pnl-section">
            <span className="pnl-modal-pnl-label">PNL</span>
            <strong className={`pnl-modal-pnl-val ${valueClass(netPnlSign)}`}>
              {formatSignedSettlementUsd(netRealizedPnl)}
            </strong>
            {pnlPercent === undefined ? null : (
              <span className={`pnl-modal-pnl-percent ${valueClass(netPnlSign)}`}>
                {formatPct(pnlPercent)}
              </span>
            )}
          </div>

          <div className="pnl-modal-market">
            <h3>{pairName}</h3>
            <span className={`pnl-modal-side pnl-modal-side-${side}`}>
              {side === "long" ? "Long" : "Short"} · Market
            </span>
          </div>

          <div className="pnl-modal-breakdown">
            <div className="pnl-modal-row">
              <span className="pnl-modal-label">Entry</span>
              <span className="pnl-modal-value">{formatNumber(entryPrice, 4)}</span>
            </div>
            <div className="pnl-modal-row">
              <span className="pnl-modal-label">Exit</span>
              <span className="pnl-modal-value">{formatNumber(closePrice, 4)}</span>
            </div>
          </div>

          {txHash ? (
            <a className="pnl-modal-tx-link" href={txUrl} rel="noopener noreferrer" target="_blank">
              <span>
                <small>SETTLEMENT TX</small>
                <strong>{compactTxHash}</strong>
              </span>
            </a>
          ) : null}
          <p aria-live="polite" className="pnl-modal-share-status">
            {shareStatus === "shared"
              ? "PNL card image shared"
              : shareStatus === "copied"
                ? "PNL card image copied"
                : shareStatus === "downloaded"
                  ? "PNL card image downloaded"
                  : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

function valueClass(sign: -1 | 0 | 1): string {
  if (sign > 0) return "pnl-positive";
  if (sign < 0) return "pnl-negative";
  return "";
}
