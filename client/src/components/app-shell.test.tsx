import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "@/components/app-shell";
import type { WalletSessionController } from "@/lib/use-wallet-session";
import type { AccountSnapshot } from "@/types/trading";

const account: AccountSnapshot = {
  accountValue: 125,
  address: "GBVC7N2A3B4C5D6E7F8G9H0J1K2L3M4N5P6Q3QJ",
  availableShieldedUsdc: 75,
  cash: 75,
  livePnl: 0,
  lockedMargin: 50,
  marginRoot: `0x${"0".repeat(64)}`,
  pendingShieldedUsdc: 0,
  privacyMode: "shielded",
  shieldedUsdc: 125,
  tradedVolume: 250,
};

const connectedWallet: WalletSessionController = {
  connect: async () => undefined,
  disconnect: () => undefined,
  error: undefined,
  session: {
    address: account.address,
    expiresAt: Date.now() + 60_000,
    ownerCommitment: `0x${"1".repeat(64)}`,
    token: "test-token",
  },
  status: "connected",
};

describe("AppShell portfolio navigation", () => {
  test("shows only the available amount in the trigger and exposes the full collateral breakdown", () => {
    const html = renderToStaticMarkup(
      <AppShell account={account} activeView="trade" wallet={connectedWallet}>
        <div />
      </AppShell>,
    );

    expect(html).toContain("Available collateral $75.00. Show collateral breakdown");
    expect(html).toContain('class="balance-menu"');
    expect(html).toContain('class="balance-trigger"');
    expect(html).toContain('class="balance-trigger"><strong>$75.00</strong>');
    expect(html).not.toContain('class="balance-trigger-label"');
    expect(html).toContain('aria-label="Collateral breakdown"');
    expect(html).toContain("In use");
    expect(html).toContain("Pending");
    expect(html).toContain("$75.00");
    expect(html).toContain("$50.00");
    expect(html).toContain("$0.00");
    expect(html).toContain('class="wallet-network-label"');
    expect(html).toContain('class="wallet-network-dot"');
    expect(html).toContain('class="wallet-network-text">Testnet</span>');
    expect(html).not.toContain("Testnet · ");
    expect(html).toContain('class="wallet-address wallet-address-wide">GBVC7N...Q3QJ</span>');
    expect(html).toContain('class="wallet-address wallet-address-compact">GBVC…Q3QJ</span>');
    expect(html).toContain(`aria-label="Wallet ${account.address}"`);
    expect(html).toContain("Connected wallet");
    expect(html).toContain("Disconnect");
    expect(html).toContain('class="account-menu"');
    expect(html).not.toContain("account-avatar");
    expect(html).not.toContain("account-button-connected");
  });

  test("does not duplicate trade balances on the portfolio route", () => {
    const html = renderToStaticMarkup(
      <AppShell account={account} activeView="portfolio" wallet={connectedWallet}>
        <div />
      </AppShell>,
    );

    expect(html).not.toContain('class="balance-menu"');
    expect(html).not.toContain("Show collateral breakdown");
    expect(html).toContain('class="wallet-network-label"');
  });

  test("shows Connect without a network prefix when disconnected", () => {
    const html = renderToStaticMarkup(
      <AppShell
        account={{ ...account, address: "" }}
        activeView="trade"
        wallet={{ ...connectedWallet, session: null, status: "idle" }}
      >
        <div />
      </AppShell>,
    );

    expect(html).toContain("Connect");
    expect(html).toContain('aria-label="Connect wallet"');
    expect(html).not.toContain('class="balance-menu"');
    expect(html).not.toContain('class="wallet-network-label"');
  });
});
