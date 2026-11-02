const DAY_MS = 86_400_000;
const WINDOW_MS = 7 * DAY_MS;

export interface VaultPerformance {
  apy: number | null;
  returnPct: number | null;
  from: string | null;
  asOf: string | null;
  status: "available" | "insufficient" | "stale";
}

interface AssetPoint { at: string; assets: string; shares: string }
interface CashFlow { id: string; at: string; amount: string; kind: string }

export function vaultPerformance(points: AssetPoint[], flows: CashFlow[], observedAt: string | null, stale: boolean): VaultPerformance {
  const empty: VaultPerformance = { apy: null, returnPct: null, from: null, asOf: observedAt,
    status: stale ? "stale" : "insufficient" };
  if (stale || !observedAt) return empty;
  const end = Date.parse(observedAt);
  if (!Number.isFinite(end)) return empty;
  const ordered = [...points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!ordered.length || ordered.some((point) => !Number.isFinite(Date.parse(point.at)) ||
    Date.parse(point.at) > end || !/^\d+$/.test(point.assets) || !/^\d+$/.test(point.shares))) return empty;
  const prior = ordered.filter((point) => Date.parse(point.at) <= end - WINDOW_MS).at(-1);
  const first = prior ?? ordered.find((point) => BigInt(point.assets) > 0n && BigInt(point.shares) > 0n);
  const last = ordered.at(-1)!;
  if (!first || BigInt(first.assets) <= 0n || BigInt(first.shares) <= 0n) return empty;
  const start = Date.parse(first.at);
  const duration = end - start;
  if (duration < DAY_MS) return empty;
  const relevant = flows.filter((flow) => flow.kind === "supply" || flow.kind === "withdrawal");
  const seen = new Set<string>();
  let netFlow = 0n;
  let weightedCapital = BigInt(first.assets) * BigInt(duration);
  for (const flow of relevant) {
    const time = Date.parse(flow.at);
    if (!Number.isFinite(time) || !/^\d+$/.test(flow.amount) || BigInt(flow.amount) <= 0n || seen.has(flow.id)) return empty;
    seen.add(flow.id);
    if (time <= start || time > end) continue;
    const amount = BigInt(flow.amount) * (flow.kind === "withdrawal" ? -1n : 1n);
    netFlow += amount;
    weightedCapital += amount * BigInt(end - time);
  }
  const windowPoints = ordered.filter((point) => Date.parse(point.at) > start);
  const hasShareChanges = windowPoints.some((point) => point.shares !== first.shares);
  if (hasShareChanges && !relevant.some((flow) => Date.parse(flow.at) > start && Date.parse(flow.at) <= end)) return empty;
  if (weightedCapital <= 0n) return empty;
  const profit = BigInt(last.assets) - BigInt(first.assets) - netFlow;
  const rate = Number(profit * BigInt(duration)) / Number(weightedCapital);
  if (!Number.isFinite(rate) || rate < -1) return empty;
  const apy = Math.expm1(Math.log1p(rate) * 365 * DAY_MS / duration) * 100;
  if (!Number.isFinite(apy)) return empty;
  return { apy, returnPct: rate * 100, from: new Date(start).toISOString(), asOf: observedAt, status: "available" };
}
