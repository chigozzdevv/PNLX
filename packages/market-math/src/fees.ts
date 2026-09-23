import { RATE_SCALE } from "./constants";
import { notional } from "./margin";

export const TAKER_FEE_PPM = 500n;
export const MAKER_REBATE_PPM = 150n;
export const INSURANCE_FEE_PPM = 100n;

export interface FillFees {
  grossTakerFee: bigint;
  makerRebate: bigint;
  insurance: bigint;
  treasury: bigint;
}

export function fillFees(size: bigint, price: bigint): FillFees {
  if (size <= 0n || price <= 0n) throw new Error("invalid fee notional");
  const value = notional(size, price);
  const grossTakerFee = value * TAKER_FEE_PPM / RATE_SCALE;
  const makerRebate = value * MAKER_REBATE_PPM / RATE_SCALE;
  const insurance = value * INSURANCE_FEE_PPM / RATE_SCALE;
  return {
    grossTakerFee,
    makerRebate,
    insurance,
    treasury: grossTakerFee - makerRebate - insurance,
  };
}
