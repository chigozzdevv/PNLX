"use client";

import { ArrowRight, ChevronDown, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { OrderTicketSubmitInput } from "@/components/order-ticket";
import { formatNumber, formatUsdc, formatUsd } from "@/lib/format";
import styles from "./order-review-dialog.module.css";

export interface OrderReview {
  baseAsset: string;
  entryPrice: number;
  exposure: number;
  input: OrderTicketSubmitInput;
  inputMode: "pointer" | "keyboard";
  liquidationPrice: number;
  marketId: string;
  maxTakerFee: number;
  pair: string;
  size: number;
  slippagePercent: number;
  walletAddress: string | null;
}

interface OrderReviewDialogProps {
  error?: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  review: OrderReview;
  submitting: boolean;
}

const FINISH_AT = 88;
const COMPLETION_MS = 180;

export function OrderReviewDialog({ error, onClose, onConfirm, review, submitting }: OrderReviewDialogProps) {
  const titleId = useId();
  const detailsId = useId();
  const noticeId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef(onConfirm);
  const lockedRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);
  const outsidePressRef = useRef(false);
  const [inputMode, setInputMode] = useState(review.inputMode);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [settling, setSettling] = useState(false);
  const busy = submitting || settling;
  const sideLabel = review.input.side === "long" ? "Long" : "Short";
  const marketOrder = review.input.orderType === "market";
  const hasProtection = Boolean(review.input.takeProfitPrice || review.input.stopLossPrice);
  const sliderLabel = submitting ? "Submitting…" : `Slide to ${sideLabel}`;

  useEffect(() => {
    confirmRef.current = onConfirm;
  }, [onConfirm]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(timerRef.current);
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  function resetSlider() {
    dragRef.current = null;
    setProgress(0);
  }

  function finish(value: number) {
    if (lockedRef.current || submitting) return;
    if (value < FINISH_AT) {
      resetSlider();
      return;
    }
    lockedRef.current = true;
    setSettling(true);
    setProgress(100);
    const duration = value >= 100 || window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : COMPLETION_MS;
    timerRef.current = window.setTimeout(async () => {
      timerRef.current = undefined;
      try {
        await confirmRef.current();
      } finally {
        lockedRef.current = false;
        if (dialogRef.current) {
          setSettling(false);
          resetSlider();
          requestAnimationFrame(() => rangeRef.current?.focus({ preventScroll: true }));
        }
      }
    }, duration);
  }

  function dragValue(clientX: number) {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag || !track) return progress;
    return Math.round(Math.max(0, Math.min(100,
      drag.startValue + (clientX - drag.startX) / Math.max(1, track.clientWidth - 52) * 100,
    )));
  }

  function startDrag(event: PointerEvent<HTMLInputElement>) {
    event.preventDefault();
    const track = trackRef.current;
    if (lockedRef.current || submitting || event.button !== 0 || !track) return;
    const thumbLeft = track.getBoundingClientRect().left + track.clientLeft + 4 + (track.clientWidth - 52) * progress / 100;
    if (event.clientX < thumbLeft || event.clientX > thumbLeft + 44) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: progress };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  }

  function endDrag(event: PointerEvent<HTMLInputElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const value = dragValue(event.clientX);
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    finish(value);
  }

  function outsideDialog(clientX: number, clientY: number) {
    const bounds = dialogRef.current?.getBoundingClientRect();
    return Boolean(bounds && (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom));
  }

  const sliderStyle = { "--review-progress": progress / 100, "--review-fill-end": `${progress}%` } as CSSProperties;

  return (
    <dialog
      aria-labelledby={titleId}
      aria-modal="true"
      className={styles.dialog}
      data-input-mode={inputMode}
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        if (!lockedRef.current && !submitting) onClose();
      }}
      onClick={(event) => {
        if (outsidePressRef.current && outsideDialog(event.clientX, event.clientY) && !lockedRef.current && !submitting) onClose();
        outsidePressRef.current = false;
      }}
      onKeyDown={(event) => {
        setInputMode("keyboard");
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")]
          .filter((control) => control.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onPointerDown={(event) => {
        setInputMode("pointer");
        outsidePressRef.current = event.target === event.currentTarget && outsideDialog(event.clientX, event.clientY);
      }}
    >
      <header className={styles.header}>
        <h2 id={titleId}>{review.pair}</h2>
        <button aria-label="Close order review" className={styles.close} disabled={busy} onClick={onClose} type="button">
          <X aria-hidden="true" size={16} />
        </button>
      </header>
      <div className={styles.context}>
        <span className={review.input.side === "long" ? styles.long : styles.short}>{sideLabel}</span>
        <span className={styles.contextDivider} aria-hidden="true" />
        <span>{marketOrder ? "Market order" : "Limit order"}</span>
        <span className={styles.contextDivider} aria-hidden="true" />
        <span>{review.input.leverage}× leverage</span>
      </div>
      <dl className={styles.summary}>
        <div><dt>Margin</dt><dd>{formatUsdc(review.input.margin)} {review.input.collateralAsset}</dd></div>
        <div>
          <dt>Position value</dt>
          <dd>{formatUsd(review.exposure, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd>
          <dd className={styles.subvalue}>{formatNumber(review.size, 4)} {review.baseAsset}</dd>
        </div>
      </dl>
      <hr className={styles.rule} />
      <dl className={styles.rows}>
        <ReviewRow label={marketOrder ? "Est. entry price" : "Limit price"} value={formatPrice(review.entryPrice)} />
        <ReviewRow label="Est. liquidation price" value={formatPrice(review.liquidationPrice)} />
        <ReviewRow label="Max taker fee" value={formatUsd(review.maxTakerFee, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} />
      </dl>
      {marketOrder || hasProtection ? (
        <>
          <button
            aria-controls={detailsId}
            aria-expanded={detailsOpen}
            className={styles.detailsToggle}
            disabled={busy}
            onClick={() => setDetailsOpen((open) => !open)}
            type="button"
          >
            <span>Order details</span><ChevronDown aria-hidden="true" size={14} />
          </button>
          <dl className={`${styles.rows} ${styles.extra}`} hidden={!detailsOpen} id={detailsId}>
            {marketOrder ? <ReviewRow label="Max slippage" value={`${formatNumber(review.slippagePercent, 2)}%`} /> : null}
            {review.input.takeProfitPrice ? <ReviewRow label="Take profit" value={formatPrice(review.input.takeProfitPrice)} /> : null}
            {review.input.stopLossPrice ? <ReviewRow label="Stop loss" value={formatPrice(review.input.stopLossPrice)} /> : null}
          </dl>
        </>
      ) : null}
      <p className={styles.notice} id={noticeId} role="note">
        <CircleAlert aria-hidden="true" size={15} />
        <strong><em>Your margin locks on submission, and proof verification may delay fills.</em></strong>
      </p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div aria-busy={busy} className={styles.slider} data-busy={submitting} data-settling={settling} ref={trackRef} style={sliderStyle}>
        <span aria-hidden="true" className={styles.fill} />
        <span className={styles.slideLabel} role="status">{submitting ? <LoaderCircle aria-hidden="true" className={styles.spinner} size={14} /> : null}{sliderLabel}</span>
        <span aria-hidden="true" className={`${styles.slideLabel} ${styles.invertedLabel}`}>{submitting ? <LoaderCircle className={styles.spinner} size={14} /> : null}{sliderLabel}</span>
        <span aria-hidden="true" className={styles.thumb}><ArrowRight size={21} strokeWidth={1.7} /></span>
        <input
          aria-describedby={noticeId}
          aria-label={`Slide to submit ${review.input.side} order`}
          aria-valuetext={busy ? "Submitting order" : progress >= FINISH_AT ? "Release to submit" : "Slide right to confirm"}
          disabled={busy}
          max={100}
          min={0}
          ref={rangeRef}
          step={1}
          type="range"
          value={progress}
          onChange={(event) => { if (!dragRef.current && !lockedRef.current) setProgress(Number(event.target.value)); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              finish(progress);
            }
          }}
          onKeyUp={(event) => {
            if (["ArrowRight", "ArrowUp", "PageUp", "End"].includes(event.key) && progress >= FINISH_AT) finish(progress);
          }}
          onLostPointerCapture={() => { if (dragRef.current) resetSlider(); }}
          onPointerCancel={() => { if (!lockedRef.current) resetSlider(); }}
          onPointerDown={startDrag}
          onPointerMove={(event) => { if (dragRef.current?.pointerId === event.pointerId) setProgress(dragValue(event.clientX)); }}
          onPointerUp={endDrag}
        />
      </div>
    </dialog>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return <div className={styles.row}><dt>{label}</dt><dd>{value}</dd></div>;
}

function formatPrice(price: number) {
  return `$${formatNumber(price, price < 10 ? 5 : 2)}`;
}
