import type { ClosePositionResult } from "@/lib/position-close";
import type { PositionRow } from "@/types/trading";

/** Summarize confirmed closes without treating the last fill's price as the whole trade's exit. */
export function summarizePositionCloses(legs: readonly PositionRow[], records: readonly ClosePositionResult[]) {
  if (legs.length === 0 || records.length !== legs.length) throw new Error("Position close summary is incomplete");
  if (legs.some((leg) => !finite(leg.size) || leg.size <= 0 || !finite(leg.entryPrice) || leg.entryPrice <= 0 ||
      !finite(leg.collateral) || leg.collateral < 0 || !finite(leg.entryFee ?? 0))) {
    throw new Error("Position close details are unavailable");
  }
  const size = legs.reduce((total, leg) => total + leg.size!, 0);
  const entryPrice = legs.reduce((total, leg) => total + leg.entryPrice! * leg.size!, 0) / size;
  const closePrice = records.reduce((total, record, index) =>
    total + Number(record.markPrice) / 100_000_000 * legs[index].size!, 0) / size;
  const settlement = records.reduce((total, record) => ({
    fee: total.fee + record.settlement.fee,
    fundingPayment: total.fundingPayment + record.settlement.fundingPayment,
    grossPricePnl: total.grossPricePnl + record.settlement.grossPricePnl,
    returnedMargin: total.returnedMargin + record.settlement.returnedMargin,
  }), { fee: 0, fundingPayment: 0, grossPricePnl: 0, returnedMargin: 0 });
  const summary = {
    ...settlement,
    size,
    entryPrice,
    closePrice,
    fee: settlement.fee + legs.reduce((total, leg) => total + (leg.entryFee ?? 0), 0),
    initialMargin: legs.reduce((total, leg) => total + leg.collateral! + (leg.entryFee ?? 0), 0),
  };
  if (Object.values(summary).some((value) => !Number.isFinite(value)) || closePrice <= 0 || size <= 0) {
    throw new Error("Position close summary is unavailable");
  }
  return summary;
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
