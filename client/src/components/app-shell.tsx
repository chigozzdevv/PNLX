"use client";

import { LogOut, UserRound, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { shortAddress } from "@/lib/format";
import type { WalletSessionController } from "@/lib/use-wallet-session";
import type { AccountSnapshot } from "@/types/trading";

const navItems = ["Trade", "Portfolio"];

interface AppShellProps {
  account: AccountSnapshot;
  children: ReactNode;
  wallet: WalletSessionController;
}

export function AppShell({ account, children, wallet }: AppShellProps) {
  const address = wallet.session?.address ?? account.address;
  const connected = Boolean(wallet.session);
  const connecting = wallet.status === "connecting";

  return (
    <div className="min-h-screen bg-[var(--surface-page)] text-[var(--text-primary)]">
      <header className="sticky top-0 z-40 border-b border-white/7 bg-[rgba(12,12,11,0.9)] backdrop-blur-xl">
        <div className="flex min-h-[72px] items-center gap-4 px-4 md:px-5">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-[10px] bg-[var(--accent-orange)] text-sm font-black text-black">
              M
            </div>
            <span className="tracking-[0.34em] text-lg font-semibold text-white">MERKL</span>
          </div>

          <nav className="hidden items-center gap-1 lg:flex">
            {navItems.map((item) => (
              <button
                className={`nav-item ${item === "Trade" ? "nav-item-active" : ""}`}
                key={item}
                type="button"
              >
                {item}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              className={`wallet-button account-button ${connected ? "account-button-connected" : ""} ${
                wallet.error ? "account-button-error" : ""
              }`}
              disabled={connecting}
              title={wallet.error}
              type="button"
              onClick={connected ? wallet.disconnect : wallet.connect}
            >
              <span className="account-avatar" aria-hidden="true">
                {connected ? <UserRound size={16} /> : <Wallet size={16} />}
              </span>
              <span className="wallet-address">
                {connecting ? "Connecting" : connected ? shortAddress(address) : "Connect"}
              </span>
              {connected ? <LogOut size={15} /> : null}
            </button>
          </div>
        </div>
      </header>

      <div className="px-2 pb-12 pt-2 md:px-3">{children}</div>
    </div>
  );
}
