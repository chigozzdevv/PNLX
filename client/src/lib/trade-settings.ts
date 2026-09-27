"use client";

import { useSyncExternalStore } from "react";

const SLIPPAGE_KEY = "pnlx.trade.slippage-percent.v1";
const SETTINGS_EVENT = "pnlx:trade-settings";
const DEFAULT_SLIPPAGE_PERCENT = 0.5;
const MIN_SLIPPAGE_PERCENT = 0.01;
const MAX_SLIPPAGE_PERCENT = 20;

let currentSlippage: number | null = null;

function readSlippagePercent(): number {
  if (currentSlippage !== null) return currentSlippage;
  if (typeof window === "undefined") return DEFAULT_SLIPPAGE_PERCENT;
  try {
    const saved = window.localStorage.getItem(SLIPPAGE_KEY);
    if (saved === null) return DEFAULT_SLIPPAGE_PERCENT;
    const value = Number(saved);
    return Number.isFinite(value) && value >= MIN_SLIPPAGE_PERCENT && value <= MAX_SLIPPAGE_PERCENT
      ? value
      : DEFAULT_SLIPPAGE_PERCENT;
  } catch {
    return DEFAULT_SLIPPAGE_PERCENT;
  }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SLIPPAGE_KEY) return;
    currentSlippage = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(SETTINGS_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(SETTINGS_EVENT, listener);
  };
}

export function useSlippagePercent(): number {
  return useSyncExternalStore(subscribe, readSlippagePercent, () => DEFAULT_SLIPPAGE_PERCENT);
}

export function saveSlippagePercent(value: number): number {
  if (!Number.isFinite(value) || typeof window === "undefined") return DEFAULT_SLIPPAGE_PERCENT;
  const next = Math.round(Math.min(Math.max(value, MIN_SLIPPAGE_PERCENT), MAX_SLIPPAGE_PERCENT) * 100) / 100;
  currentSlippage = next;
  try {
    window.localStorage.setItem(SLIPPAGE_KEY, String(next));
  } catch {
    // Keep the setting for this tab when storage is unavailable.
  }
  window.dispatchEvent(new Event(SETTINGS_EVENT));
  return next;
}
