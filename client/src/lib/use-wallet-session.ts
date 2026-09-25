"use client";

import { useEffect, useState } from "react";
import {
  clearWalletSession,
  connectWalletSession,
  privateNoteBackupWarning,
  readWalletSession,
  validateWalletSession,
  type WalletSession,
} from "@/lib/wallet-auth";

type WalletStatus = "idle" | "connecting" | "connected" | "error";

interface WalletState {
  session: WalletSession | null;
  status: WalletStatus;
}

export interface WalletSessionController {
  connect: () => Promise<void>;
  disconnect: () => void;
  error: string | undefined;
  session: WalletSession | null;
  status: WalletStatus;
}

export function useWalletSession(): WalletSessionController {
  const [error, setError] = useState<string | undefined>();
  const [state, setState] = useState<WalletState>(() => {
    const stored = readWalletSession();
    return {
      session: stored,
      status: stored ? "connected" : "idle",
    };
  });

  useEffect(() => {
    const updateBackupWarning = () => setError(privateNoteBackupWarning());
    window.addEventListener("pnlx:private-note-backup-status", updateBackupWarning);
    return () => window.removeEventListener("pnlx:private-note-backup-status", updateBackupWarning);
  }, []);

  useEffect(() => {
    let active = true;
    if (!readWalletSession()) return undefined;

    validateWalletSession().then((validated) => {
      if (!active) return;
      setError(privateNoteBackupWarning());
      setState({
        session: validated,
        status: validated ? "connected" : "idle",
      });
    });

    return () => {
      active = false;
    };
  }, []);

  async function connect(): Promise<void> {
    setError(undefined);
    setState((current) => ({ ...current, status: "connecting" }));
    try {
      const nextSession = await connectWalletSession();
      setError(privateNoteBackupWarning());
      setState({ session: nextSession, status: "connected" });
    } catch (caught) {
      setState({ session: null, status: "error" });
      setError(caught instanceof Error ? caught.message : "Wallet connection failed");
    }
  }

  function disconnect(): void {
    clearWalletSession();
    setError(undefined);
    setState({ session: null, status: "idle" });
  }

  return {
    connect,
    disconnect,
    error,
    session: state.session,
    status: state.status,
  };
}
