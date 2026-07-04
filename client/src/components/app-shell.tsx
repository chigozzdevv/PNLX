"use client";

import { LogOut, UserRound, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatUsd, shortAddress } from "@/lib/format";
import type { WalletSessionController } from "@/lib/use-wallet-session";
import type { AccountSnapshot } from "@/types/trading";

export type AppView = "trade" | "portfolio";

const navItems: Array<{ href: string; id: AppView; label: string }> = [
  { href: "/trade", id: "trade", label: "Trade" },
  { href: "/portfolio", id: "portfolio", label: "Portfolio" },
];

interface AppShellProps {
  account: AccountSnapshot;
  activeView: AppView;
  children: ReactNode;
  wallet: WalletSessionController;
}

export function AppShell({ account, activeView, children, wallet }: AppShellProps) {
  const address = wallet.session?.address ?? account.address;
  const connected = Boolean(wallet.session);
  const connecting = wallet.status === "connecting";

  return (
    <div className="min-h-screen bg-[var(--surface-page)] text-[var(--text-primary)]">
      <header className="sticky top-0 z-40 border-b border-white/7 bg-[rgba(12,12,11,0.9)] backdrop-blur-xl">
        <div className="flex min-h-[72px] min-w-0 items-center gap-3 px-3 md:gap-4 md:px-5">
          <Link className="app-brand" href="/" aria-label="PNLX home">
            <Image
              alt="PNLX"
              className="app-brand-logo"
              height={25}
              priority
              src="/pnlx-logo.png"
              width={138}
            />
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            {navItems.map((item) => (
              <Link
                className={`nav-item ${item.id === activeView ? "nav-item-active" : ""}`}
                href={item.href}
                key={item.id}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="wallet-area ml-auto">
            {connected ? (
              <>
                <div className="header-balance" aria-label="Available collateral">
                  <span>Available</span>
                  <strong>{formatUsd(account.availableShieldedUsdc ?? 0)}</strong>
                </div>
                {account.lockedMargin > 0 ? (
                  <div className="header-balance" aria-label="Locked collateral">
                    <span>Locked</span>
                    <strong>{formatUsd(account.lockedMargin)}</strong>
                  </div>
                ) : null}
                {account.pendingShieldedUsdc > 0 ? (
                  <div className="header-balance" aria-label="Pending collateral">
                    <span>Pending</span>
                    <strong>{formatUsd(account.pendingShieldedUsdc)}</strong>
                  </div>
                ) : null}
              </>
            ) : null}
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
