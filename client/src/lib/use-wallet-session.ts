"use client";

import { useEffect, useState } from "react";
import {
  clearWalletSession,
  connectWalletSession,
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
    let active = true;
    if (!readWalletSession()) return undefined;

    validateWalletSession().then((validated) => {
      if (!active) return;
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
