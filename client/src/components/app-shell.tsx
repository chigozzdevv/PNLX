"use client";

import { ChevronDown, LogOut, Wallet } from "lucide-react";
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
  const availableCollateral = formatUsd(account.availableShieldedUsdc ?? 0);
  const compactAddress = address.length <= 10
    ? address
    : `${address.slice(0, 4)}…${address.slice(-4)}`;

  return (
    <div className="min-h-screen bg-[var(--surface-page)] text-[var(--text-primary)]">
      <header className="sticky top-0 z-40 border-b border-white/7 bg-[rgba(12,12,11,0.9)] backdrop-blur-xl">
        <div className="app-header-inner flex min-h-[72px] min-w-0 items-center gap-3 px-3 md:gap-4 md:px-5">
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

          <div className="header-controls ml-auto">
            {connected && activeView === "trade" ? (
              <details className="balance-menu">
                <summary
                  aria-label={`Available collateral ${availableCollateral}. Show collateral breakdown`}
                  className="balance-trigger"
                >
                  <span className="balance-trigger-label">Available</span>
                  <strong>{availableCollateral}</strong>
                  <ChevronDown aria-hidden="true" className="balance-chevron" size={13} />
                </summary>
                <div className="balance-popover">
                  <span className="balance-popover-heading">Collateral</span>
                  <dl aria-label="Collateral breakdown">
                    <div>
                      <dt>Available</dt>
                      <dd>{availableCollateral}</dd>
                    </div>
                    <div>
                      <dt>In use</dt>
                      <dd>{formatUsd(account.lockedMargin)}</dd>
                    </div>
                    <div>
                      <dt>Pending</dt>
                      <dd>{formatUsd(account.pendingShieldedUsdc)}</dd>
                    </div>
                  </dl>
                </div>
              </details>
            ) : null}
            <div className="wallet-area">
              {connected ? (
                <span className="wallet-network-label" aria-label="Network: Stellar Testnet">
                  <span className="wallet-network-dot" aria-hidden="true" />
                  <span className="wallet-network-text">Testnet</span>
                </span>
              ) : null}
              {connected ? (
                <details className={`account-menu${wallet.error ? " account-button-error" : ""}`}>
                  <summary
                    aria-label={`Wallet ${address}`}
                    className="wallet-button account-trigger"
                    title={wallet.error ?? "Wallet menu"}
                  >
                    <span className="wallet-address wallet-address-wide">{shortAddress(address)}</span>
                    <span className="wallet-address wallet-address-compact">{compactAddress}</span>
                    <ChevronDown aria-hidden="true" className="account-chevron" size={14} />
                  </summary>
                  <div className="account-popover">
                    <span>Connected wallet</span>
                    <strong aria-label={`Full wallet address: ${address}`} title={address}>
                      {shortAddress(address)}
                    </strong>
                    <button onClick={wallet.disconnect} type="button">
                      <LogOut aria-hidden="true" size={14} />
                      Disconnect
                    </button>
                  </div>
                </details>
              ) : (
                <button
                  aria-label="Connect wallet"
                  className={`wallet-button account-button ${wallet.error ? "account-button-error" : ""}`}
                  disabled={connecting}
                  title={wallet.error}
                  type="button"
                  onClick={wallet.connect}
                >
                  <Wallet aria-hidden="true" size={15} />
                  <span className="wallet-address">{connecting ? "Connecting" : "Connect"}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="px-2 pb-12 pt-2 md:px-3">{children}</div>
    </div>
  );
}
