"use client";

import { ChevronDown, Gift, LogOut, Menu, Moon, Plus, Settings, Sun, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { formatUsd, shortAddress } from "@/lib/format";
import { APP_HOME_HREF } from "@/lib/app-url";
import { saveSlippagePercent, useSlippagePercent } from "@/lib/trade-settings";
import { useTradingData } from "@/lib/use-trading-data";
import type { WalletSessionController } from "@/lib/use-wallet-session";
import type { AccountSnapshot } from "@/types/trading";

export type AppView = "trade" | "portfolio" | "liquidity" | "points" | "rewards";

const navItems: Array<{ href: string; id: AppView; label: string }> = [
  { href: APP_HOME_HREF, id: "trade", label: "Trade" },
  { href: "/portfolio", id: "portfolio", label: "Portfolio" },
  { href: "/liquidity", id: "liquidity", label: "Liquidity" },
  { href: "/points", id: "points", label: "Points" },
];

interface AppShellProps {
  account?: AccountSnapshot | null;
  activeView: AppView;
  children: ReactNode;
  onOpenDeposit?: () => void;
  onRepairCollateral?: () => void;
  showRepairCollateral?: boolean;
  wallet: WalletSessionController;
}

export function AppShell({
  account,
  activeView,
  children,
  onOpenDeposit,
  onRepairCollateral,
  showRepairCollateral = false,
  wallet,
}: AppShellProps) {
  const headerControlsRef = useRef<HTMLDivElement>(null);
  const address = wallet.session?.address ?? account?.address ?? "";
  const connected = Boolean(wallet.session);
  const connecting = wallet.status === "connecting";
  const compactAddress = address.length <= 10
    ? address
    : `${address.slice(0, 4)}…${address.slice(-4)}`;

  useEffect(() => {
    const openMenu = () => headerControlsRef.current?.querySelector<HTMLDetailsElement>('details[name="pnlx-header-menu"][open]');
    const closeOnOutsideClick = (event: PointerEvent) => {
      const menu = openMenu();
      if (menu && !event.composedPath().includes(menu)) menu.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const menu = openMenu();
      if (event.key !== "Escape" || !menu) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector<HTMLElement>("summary")?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <div className={`app-shell app-shell-${activeView} min-h-screen bg-[var(--surface-page)] text-[var(--text-primary)]`}>
      <header className="app-header sticky top-0 z-40 backdrop-blur-xl">
        <div className="app-header-inner flex min-w-0 items-center gap-3 md:gap-4">
          <Link className="app-brand" href={APP_HOME_HREF} aria-label="PNLX home">
            <Image alt="PNLX" className="app-brand-logo" height={25} priority src="/pnlx-logo.png" width={138} />
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            {navItems.map((item) => (
              <Link className={`nav-item ${item.id === activeView ? "nav-item-active" : ""}`} href={item.href} key={item.id}>
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="header-controls ml-auto" ref={headerControlsRef}>
            {wallet.session ? account !== undefined ? (
              <CollateralBalanceMenu
                account={account ?? undefined}
                onOpenDeposit={onOpenDeposit}
                onRepairCollateral={onRepairCollateral}
                showRepairCollateral={showRepairCollateral}
              />
            ) : <LoadedCollateralBalanceMenu session={wallet.session} /> : null}
            <Link
              aria-current={activeView === "rewards" ? "page" : undefined}
              aria-label="Rewards"
              className={`header-rewards-link${activeView === "rewards" ? " header-rewards-link-active" : ""}`}
              href="/rewards"
              title="Rewards"
            >
              <Gift aria-hidden="true" size={17} strokeWidth={2} />
            </Link>
            <div className="wallet-area">
              <details className="header-settings" name="pnlx-header-menu">
                  <summary aria-label="Settings" title="Settings">
                    <Settings aria-hidden="true" size={16} />
                  </summary>
                  <div className="header-settings-popover">
                    <span className="header-settings-heading">Settings</span>
                    <div className="header-settings-panel">
                      <ThemeSetting />
                      <SlippageSetting />
                      <label className="account-network-setting">
                        <span>Network</span>
                        <span className="account-network-select">
                          <select defaultValue="testnet">
                            <option value="testnet">Testnet</option>
                            <option disabled value="mainnet">Mainnet</option>
                          </select>
                          <ChevronDown aria-hidden="true" size={12} />
                        </span>
                      </label>
                    </div>
                  </div>
              </details>
              {connected ? (
                <details className={`account-menu${wallet.error ? " account-button-error" : ""}`} name="pnlx-header-menu">
                  <summary
                    aria-label={`Wallet ${address}`}
                    className="wallet-button account-trigger"
                    title={wallet.error ?? "Wallet menu"}
                  >
                    <Wallet aria-hidden="true" className="account-wallet-icon" size={16} />
                    <span className="wallet-address wallet-address-wide">{shortAddress(address)}</span>
                    <span className="wallet-address wallet-address-compact">{compactAddress}</span>
                    <ChevronDown aria-hidden="true" className="account-chevron" size={14} />
                  </summary>
                  <div className="account-popover">
                    <span>Connected wallet</span>
                    <strong aria-label={`Full wallet address: ${address}`} title={address}>
                      {shortAddress(address)}
                    </strong>
                    <button className="account-disconnect" onClick={wallet.disconnect} type="button">
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
            <details className="mobile-page-menu" name="pnlx-header-menu">
              <summary aria-label="Navigation menu" title="Navigation menu">
                <Menu aria-hidden="true" size={20} strokeWidth={1.75} />
              </summary>
              <nav aria-label="App pages" className="mobile-page-popover">
                {[...navItems, { href: "/rewards", id: "rewards", label: "Rewards" }].map((item) => (
                  <Link
                    aria-current={item.id === activeView ? "page" : undefined}
                    className={item.id === activeView ? "mobile-page-active" : undefined}
                    href={item.href}
                    key={item.id}
                    onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </details>
          </div>
        </div>
      </header>

      {connected && wallet.error ? <p className="private-backup-warning" role="alert">{wallet.error}</p> : null}

      <div className="app-content px-2 pb-12 pt-2 md:px-3">{children}</div>
    </div>
  );
}

function LoadedCollateralBalanceMenu({ session }: { session: NonNullable<WalletSessionController["session"]> }) {
  const trading = useTradingData(session);
  const account = !trading.loading && !trading.error && trading.data.account.address === session.address
    ? trading.data.account : undefined;

  return <CollateralBalanceMenu account={account} loading={trading.loading} />;
}

function CollateralBalanceMenu({
  account,
  loading = false,
  onOpenDeposit,
  onRepairCollateral,
  showRepairCollateral = false,
}: {
  account?: AccountSnapshot;
  loading?: boolean;
  onOpenDeposit?: () => void;
  onRepairCollateral?: () => void;
  showRepairCollateral?: boolean;
}) {
  const totalCollateral = account?.accountValue == null ? "—" : formatUsd(account.accountValue);

  return (
    <details className="balance-menu" name="pnlx-header-menu">
      <summary
        aria-label={totalCollateral !== "—" ? `Total collateral ${totalCollateral}. Show collateral breakdown` : "Collateral balance unavailable. Show details"}
        className="balance-trigger"
      >
        <strong>{totalCollateral}</strong>
        <ChevronDown aria-hidden="true" className="balance-chevron" size={13} />
      </summary>
      <div className="balance-popover">
        <span className="balance-popover-heading">Collateral</span>
        {account ? (
          <dl aria-label="Collateral breakdown">
            <div><dt>Available</dt><dd>{account.availableShieldedUsdc == null ? "—" : formatUsd(account.availableShieldedUsdc)}</dd></div>
            <div><dt>In use</dt><dd>{formatUsd(account.lockedMargin)}</dd></div>
            <div><dt>Pending</dt><dd>{formatUsd(account.pendingShieldedUsdc)}</dd></div>
          </dl>
        ) : <p className="balance-popover-unavailable">{loading ? "Loading balance…" : "Balance unavailable."}</p>}
        {onOpenDeposit || (showRepairCollateral && onRepairCollateral) ? (
          <div className="balance-popover-action">
            {onOpenDeposit ? (
              <button
                className="balance-deposit-action"
                type="button"
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  onOpenDeposit();
                }}
              >
                <Plus aria-hidden="true" size={13} />
                Deposit
              </button>
            ) : null}
            {showRepairCollateral && onRepairCollateral ? (
              <button className="balance-repair-action" type="button" onClick={onRepairCollateral}>
                Repair collateral
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SlippageSetting() {
  const slippagePercent = useSlippagePercent();

  return (
    <label className="account-slippage-setting">
      <span>Slippage</span>
      <span className="account-slippage-input">
        <input
          aria-label="Market slippage percentage"
          defaultValue={slippagePercent}
          inputMode="decimal"
          key={slippagePercent}
          max={20}
          min={0.01}
          onBlur={(event) => {
            const raw = event.currentTarget.value.trim();
            const value = raw ? Number(raw) : NaN;
            if (Number.isFinite(value)) event.currentTarget.value = String(saveSlippagePercent(value));
            else event.currentTarget.value = String(slippagePercent);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          step={0.01}
          type="number"
        />
        <span>%</span>
      </span>
    </label>
  );
}

function ThemeSetting() {
  const theme = useSyncExternalStore(
    (notify) => {
      window.addEventListener("pnlx-theme-change", notify);
      return () => window.removeEventListener("pnlx-theme-change", notify);
    },
    () => document.documentElement.dataset.theme === "light" ? "light" : "dark",
    () => "dark",
  );

  const selectTheme = (next: "dark" | "light") => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("pnlx-theme", next); } catch { /* Storage may be unavailable. */ }
    window.dispatchEvent(new Event("pnlx-theme-change"));
  };

  return (
    <label className="account-theme-setting">
      <span>Theme</span>
      <span className="account-theme-select">
        {theme === "dark" ? <Moon aria-hidden="true" size={13} /> : <Sun aria-hidden="true" size={13} />}
        <select aria-label="Theme" onChange={(event) => selectTheme(event.target.value === "light" ? "light" : "dark")} value={theme}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <ChevronDown aria-hidden="true" size={12} />
      </span>
    </label>
  );
}
