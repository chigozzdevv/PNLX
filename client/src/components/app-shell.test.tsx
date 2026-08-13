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
  test("keeps trade balances and prefixes the connected address with Testnet", () => {
    const html = renderToStaticMarkup(
      <AppShell account={account} activeView="trade" wallet={connectedWallet}>
        <div />
      </AppShell>,
    );

    expect(html).toContain("Available collateral");
    expect(html).toContain("Locked collateral");
    expect(html).toContain("Testnet · ");
    expect(html).toContain("GBVC7N...Q3QJ");
  });

  test("does not duplicate trade balances on the portfolio route", () => {
    const html = renderToStaticMarkup(
      <AppShell account={account} activeView="portfolio" wallet={connectedWallet}>
        <div />
      </AppShell>,
    );

    expect(html).not.toContain("Available collateral");
    expect(html).not.toContain("Locked collateral");
    expect(html).toContain("Testnet · ");
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
    expect(html).not.toContain("Testnet · ");
  });
});
