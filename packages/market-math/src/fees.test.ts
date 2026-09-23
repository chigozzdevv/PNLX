import { expect, test } from "bun:test";
import { fillFees } from "./fees";
import { PRICE_SCALE } from "./constants";

test("splits a $1,000 fill in base units", () => {
  expect(fillFees(10_000_000_000n, PRICE_SCALE)).toEqual({
    grossTakerFee: 5_000_000n,
    makerRebate: 1_500_000n,
    insurance: 1_000_000n,
    treasury: 2_500_000n,
  });
});

test("assigns integer rounding remainder to treasury", () => {
  const fees = fillFees(19_999n, PRICE_SCALE);
  expect(fees.grossTakerFee).toBe(9n);
  expect(fees.makerRebate).toBe(2n);
  expect(fees.insurance).toBe(1n);
  expect(fees.treasury).toBe(6n);
  expect(fees.grossTakerFee).toBe(fees.makerRebate + fees.insurance + fees.treasury);
});
