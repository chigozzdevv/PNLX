"use client";

import { Check } from "lucide-react";
import { useEffect, useRef } from "react";

interface ActionToastProps {
  durationMs?: number;
  message?: string;
  onDismiss: () => void;
}

export function ActionToast({ durationMs = 3_500, message, onDismiss }: ActionToastProps) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => onDismissRef.current(), durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, message]);

  if (!message) return null;

  return (
    <div aria-live="polite" className="action-toast" role="status">
      <span aria-hidden="true" className="action-toast-icon">
        <Check size={15} strokeWidth={2.2} />
      </span>
      <span>{message}</span>
    </div>
  );
}
