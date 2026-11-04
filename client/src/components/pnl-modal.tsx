"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { Check, Download, Share } from "lucide-react";
import { LoadingDots } from "@/components/loading-dots";
import {
  formatNumber,
  formatPct,
  formatSignedPnlUsd,
  settlementAmountSign,
} from "@/lib/format";
import {
  createPnlShareCardFile,
  PNL_CARD_BACKGROUND,
  PNL_CARD_LOGO,
  preloadPnlShareCardAssets,
} from "@/lib/pnl-share-card";

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
  returnedMargin,
  side,
  txHash,
}: PnlModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const shareActionsRef = useRef<HTMLDivElement>(null);
  const shareButtonRef = useRef<HTMLButtonElement>(null);
  const shareOptionsId = useId();
  const onCloseRef = useRef(onClose);
  const [shareOptionsOpen, setShareOptionsOpen] = useState(false);
  const [assetsStatus, setAssetsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [shareStatus, setShareStatus] = useState<"idle" | "sharing" | "downloading" | "shared" | "copied" | "downloaded" | "error">("idle");
  const visible = isOpen && assetsStatus !== "loading";
  const preparingImage = shareStatus === "sharing" || shareStatus === "downloading";

  useEffect(() => {
    if (!shareOptionsOpen) return;
    function handleOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && !shareActionsRef.current?.contains(event.target)) {
        setShareOptionsOpen(false);
      }
    }
    document.addEventListener("pointerdown", handleOutsidePress);
    return () => document.removeEventListener("pointerdown", handleOutsidePress);
  }, [shareOptionsOpen]);

  useEffect(() => {
    let active = true;
    preloadPnlShareCardAssets().then(
      () => { if (active) setAssetsStatus("ready"); },
      () => { if (active) setAssetsStatus("error"); },
    );
    return () => { active = false; };
  }, [isOpen]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (shareStatus !== "shared" && shareStatus !== "copied" && shareStatus !== "downloaded") return;
    const clearStatus = window.setTimeout(() => setShareStatus("idle"), 2_400);
    return () => window.clearTimeout(clearStatus);
  }, [shareStatus]);

  useEffect(() => {
    if (!visible) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const focusFrame = requestAnimationFrame(() => dialogRef.current?.focus({ preventScroll: true }));
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (shareActionsRef.current?.querySelector("[data-share-options]")) {
          setShareOptionsOpen(false);
          shareButtonRef.current?.focus({ preventScroll: true });
          return;
        }
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
      document.documentElement.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [visible]);

  if (!isOpen) return null;

  const pairName = `${marketId.split("-")[0]?.toUpperCase() || "PERP"}/USD`;
  const fundingImpact = -fundingPayment;
  const feeImpact = -fee;
  const netRealizedPnl = initialMargin !== undefined && Number.isFinite(initialMargin) && Number.isFinite(returnedMargin)
    ? returnedMargin - initialMargin
    : grossPricePnl + fundingImpact + feeImpact;
  const netPnlSign = settlementAmountSign(netRealizedPnl);
  const pnlPercent = initialMargin && initialMargin > 0 ? (netRealizedPnl / initialMargin) * 100 : undefined;
  const formattedPnl = formatSignedPnlUsd(netRealizedPnl);
  const txUrl = txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash.replace(/^0x/, "")}` : undefined;
  async function handleShare(action: "share" | "download") {
    setShareOptionsOpen(false);
    setShareStatus(action === "download" ? "downloading" : "sharing");
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
        action === "share"
        && typeof navigator.share === "function"
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

      if (action === "share" && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": imageFile }),
          ]);
          setShareStatus("copied");
          return;
        } catch {}
      }

      const imageUrl = URL.createObjectURL(imageFile);
      const download = document.createElement("a");
      download.download = imageFile.name;
      download.href = imageUrl;
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(imageUrl), 1_000);
      setShareStatus("downloaded");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setShareStatus("idle");
        return;
      }
      setShareStatus("error");
    }
  }

  return (
    <div
      className="pnl-modal-overlay"
      hidden={!visible}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        setShareOptionsOpen(false);
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
        tabIndex={-1}
      >
        {assetsStatus === "ready" ? <div aria-hidden="true" className="pnl-modal-art" style={{ backgroundImage: `url(${PNL_CARD_BACKGROUND})` }} /> : null}
        <div aria-hidden="true" className="pnl-modal-shade" />
        <header className="pnl-modal-header">
          {assetsStatus === "ready" ? (
            <Image alt="PNLX" className="pnl-modal-logo" height={21} src={PNL_CARD_LOGO} unoptimized width={112} />
          ) : <span className="pnl-modal-brand">PNLX</span>}
          <div className="pnl-modal-share-actions" ref={shareActionsRef}>
            <button
              aria-label="Share PNL card"
              aria-expanded={shareOptionsOpen}
              aria-controls={shareOptionsId}
              className="pnl-modal-share"
              disabled={preparingImage}
              onClick={() => setShareOptionsOpen((open) => !open)}
              ref={shareButtonRef}
              type="button"
            >
              {preparingImage ? <LoadingDots /> : ["shared", "copied", "downloaded"].includes(shareStatus)
                ? <Check aria-hidden="true" size={20} />
                : <Share aria-hidden="true" size={20} />}
            </button>
            {shareOptionsOpen ? (
              <div aria-label="Share options" className="pnl-modal-share-options" data-share-options id={shareOptionsId} role="group">
                <button onClick={() => void handleShare("share")} type="button"><Share aria-hidden="true" size={16} />Share</button>
                <button onClick={() => void handleShare("download")} type="button"><Download aria-hidden="true" size={16} />Download</button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="pnl-modal-market">
          <h3>{pairName}</h3>
          <span className="pnl-modal-side">{side === "long" ? "Long" : "Short"}</span>
        </div>
        <div className="pnl-modal-pnl-section">
          <span className="pnl-modal-pnl-label">Realized P&L</span>
          <strong className="pnl-modal-pnl-val" style={{ fontSize: `min(var(--pnl-amount-size), ${136 / Math.max(formattedPnl.length, 8)}cqi)` }}>
            {formattedPnl}
          </strong>
          {pnlPercent === undefined ? null : (
            <div className="pnl-modal-return">
              <span className={`pnl-modal-pnl-percent ${valueClass(netPnlSign)}`}>{formatPct(pnlPercent)}</span>
              <span>return</span>
            </div>
          )}
        </div>

        <div className="pnl-modal-bottom">
          <div className="pnl-modal-breakdown">
            <div className="pnl-modal-row">
              <span className="pnl-modal-label">Entry price</span>
              <span className="pnl-modal-value">${formatNumber(entryPrice, 4)}</span>
            </div>
            <div className="pnl-modal-row">
              <span className="pnl-modal-label">Exit price</span>
              <span className="pnl-modal-value">${formatNumber(closePrice, 4)}</span>
            </div>
          </div>
          <footer className="pnl-modal-footer">
            <span>pnlx.trade</span>
            {txUrl ? (
              <a aria-label="View settlement transaction on Stellar Testnet" href={txUrl} rel="noopener noreferrer" target="_blank">Stellar Testnet</a>
            ) : <span>Stellar Testnet</span>}
          </footer>
        </div>
        <p aria-live="polite" className="pnl-modal-share-status">
          {shareStatus === "shared"
            ? "PNL card image shared"
            : shareStatus === "copied"
              ? "PNL card image copied"
              : shareStatus === "downloaded"
                ? "PNL card image downloaded"
                : shareStatus === "error"
                  ? "Image could not be saved or shared. Try again."
                  : ""}
        </p>
      </div>
    </div>
  );
}

function valueClass(sign: -1 | 0 | 1): string {
  if (sign > 0) return "pnl-positive";
  if (sign < 0) return "pnl-negative";
  return "";
}
