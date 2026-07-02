import { Activity, LockKeyhole, ShieldCheck, WalletCards } from "lucide-react";
import { formatUsd, shortAddress } from "@/lib/format";
import type { AccountSnapshot } from "@/types/trading";

interface AccountStripProps {
  account: AccountSnapshot;
  accountEventCount: number;
  ordersCount: number;
  positionsCount: number;
}

export function AccountStrip({
  account,
  accountEventCount,
  ordersCount,
  positionsCount,
}: AccountStripProps) {
  const cards = [
    {
      icon: WalletCards,
      label: "Shielded USDC",
      value: account.shieldedUsdc === null ? "Private" : formatUsd(account.shieldedUsdc),
    },
    {
      icon: LockKeyhole,
      label: "Locked Margin",
      value: formatUsd(account.lockedMargin),
    },
    {
      icon: Activity,
      label: "Open Trades",
      value: String(positionsCount),
    },
    {
      icon: ShieldCheck,
      label: "Events",
      value: String(accountEventCount + ordersCount),
    },
  ];

  return (
    <section className="account-strip">
      {cards.map((card) => {
        const Icon = card.icon;

        return (
          <div className="account-card" key={card.label}>
            <Icon size={16} />
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </div>
        );
      })}

      <div className="account-card account-card-address">
        <span>Wallet</span>
        <strong>{account.address ? shortAddress(account.address) : "--"}</strong>
      </div>
    </section>
  );
}
