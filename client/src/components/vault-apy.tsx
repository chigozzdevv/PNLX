import { LoadingDots } from "@/components/loading-dots";
import { formatNumber } from "@/lib/format";
import type { VaultHistory } from "@/lib/liquidity-vault";

export function VaultApy({ history }: { history: VaultHistory | null }) {
  const performance = history?.performance;
  const available = !history?.stale && performance?.status === "available" &&
    performance.apy !== null && Number.isFinite(performance.apy);
  const period = performance?.from && performance.asOf
    ? `${new Date(performance.from).toLocaleDateString()}–${new Date(performance.asOf).toLocaleDateString()}` : "recent history";
  return <strong title={available
    ? `Estimated annual yield from settled returns (${period}), adjusted for deposits and withdrawals. Excludes unsettled P&L.`
    : performance?.status === "insufficient" ? "More settled return history is needed." : "Updating pool returns."}>
    {available ? `${formatNumber(performance.apy!, 2)}%` : !history || history.stale
      ? <LoadingDots label="Updating pool APY" /> : "—"}
  </strong>;
}
