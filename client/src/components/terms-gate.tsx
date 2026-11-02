"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { TermsDialog } from "@/components/terms-dialog";
import { hasCurrentTermsAcceptance, TERMS_STORAGE_KEY, TERMS_VERSION } from "@/lib/terms";

const ACCEPTANCE_EVENT = "pnlx:terms-acceptance";
let acceptedForSession = false;

function readAcceptance(): "accepted" | "required" {
  if (acceptedForSession) return "accepted";
  try {
    return hasCurrentTermsAcceptance(window.localStorage.getItem(TERMS_STORAGE_KEY)) ? "accepted" : "required";
  } catch {
    return "required";
  }
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== TERMS_STORAGE_KEY && event.key !== null) return;
    acceptedForSession = false;
    listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(ACCEPTANCE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(ACCEPTANCE_EVENT, listener);
  };
}

function acceptTerms() {
  acceptedForSession = true;
  try {
    window.localStorage.setItem(TERMS_STORAGE_KEY, JSON.stringify({
      version: TERMS_VERSION,
      acceptedAt: new Date().toISOString(),
    }));
  } catch {
    return;
  } finally {
    window.dispatchEvent(new Event(ACCEPTANCE_EVENT));
  }
}

export function TermsGate({ children, className }: { children: ReactNode; className: string }) {
  const status = useSyncExternalStore<"accepted" | "required" | "checking">(subscribe, readAcceptance, () => "checking");

  return (
    <>
      <div className={className} inert={status !== "accepted"}>{children}</div>
      {status === "required" ? <TermsDialog onAccept={acceptTerms} /> : null}
    </>
  );
}
