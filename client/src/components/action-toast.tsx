"use client";

import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";

interface ActionToastProps {
  durationMs?: number;
  message?: string;
  onDismiss: () => void;
}

export function ActionToast({ durationMs = 3_500, message, onDismiss }: ActionToastProps) {
  const onDismissRef = useRef(onDismiss);
  const toastRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const toast = toastRef.current;
    if (!message || !toast) return;
    let remaining = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 3_500;
    let startedAt = 0;
    let timer: number | undefined;
    let hovered = toast.matches(":hover");
    let focused = toast.contains(document.activeElement);
    const pause = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, remaining - (performance.now() - startedAt));
    };
    const resume = () => {
      if (hovered || focused || timer !== undefined) return;
      startedAt = performance.now();
      timer = window.setTimeout(() => {
        timer = undefined;
        onDismissRef.current();
      }, remaining);
    };
    const onMouseEnter = () => { hovered = true; pause(); };
    const onMouseLeave = () => { hovered = false; resume(); };
    const onFocusIn = () => { focused = true; pause(); };
    const onFocusOut = (event: FocusEvent) => {
      focused = toast.contains(event.relatedTarget as Node | null);
      if (!focused) resume();
    };
    toast.addEventListener("mouseenter", onMouseEnter);
    toast.addEventListener("mouseleave", onMouseLeave);
    toast.addEventListener("focusin", onFocusIn);
    toast.addEventListener("focusout", onFocusOut);
    resume();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      toast.removeEventListener("mouseenter", onMouseEnter);
      toast.removeEventListener("mouseleave", onMouseLeave);
      toast.removeEventListener("focusin", onFocusIn);
      toast.removeEventListener("focusout", onFocusOut);
    };
  }, [durationMs, message]);

  if (!message) return null;

  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className="action-toast"
      ref={toastRef}
      role="status"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
    >
      <span aria-hidden="true" className="action-toast-icon">
        <Check size={15} strokeWidth={2.2} />
      </span>
      <span className="action-toast-message">{message}</span>
      <button aria-label="Dismiss notification" className="action-toast-close" onClick={onDismiss} type="button">
        <X aria-hidden="true" size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}
