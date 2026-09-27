import { describe, expect, test } from "bun:test";
import { allocateCreditDropFill, creditDropContribution, splitCreditDropClose } from "./credit-drops";

describe("Credit Drop equity", () => {
  test("returns sponsored principal first after fees, funding and PnL", () => {
    expect(splitCreditDropClose(120n, 10n)).toEqual({ traderAmount: 110n, reserveAmount: 10n, reserveLoss: 0n });
    expect(splitCreditDropClose(80n, 10n)).toEqual({ traderAmount: 70n, reserveAmount: 10n, reserveLoss: 0n });
    expect(splitCreditDropClose(6n, 10n)).toEqual({ traderAmount: 0n, reserveAmount: 6n, reserveLoss: 4n });
    expect(splitCreditDropClose(0n, 10n)).toEqual({ traderAmount: 0n, reserveAmount: 0n, reserveLoss: 10n });
    expect(splitCreditDropClose(120n, 0n)).toEqual({ traderAmount: 120n, reserveAmount: 0n, reserveLoss: 0n });
    expect(() => splitCreditDropClose(-1n, 10n)).toThrow();
  });

  test("covers as much margin as the credit balance allows", () => {
    expect(creditDropContribution(100n, 120n)).toEqual({ traderMargin: 0n, sponsoredMargin: 100n });
    expect(creditDropContribution(100n, 30n)).toEqual({ traderMargin: 70n, sponsoredMargin: 30n });
    expect(creditDropContribution(100n, 0n)).toEqual({ traderMargin: 100n, sponsoredMargin: 0n });
    expect(() => creditDropContribution(0n, 100n)).toThrow();
  });

  test("partial fills conserve both owners' principal at rounding boundaries", () => {
    for (let trader = 0n; trader <= 12n; trader++) {
      for (let sponsor = 1n; sponsor <= 12n; sponsor++) {
        for (let size = 1n; size <= 12n; size++) {
          let usedTrader = 0n;
          let usedSponsor = 0n;
          for (let filled = 0n; filled < size; filled++) {
            const part = allocateCreditDropFill({ orderSize: size, filledSize: filled,
              fillSize: 1n, traderMargin: trader, sponsoredMargin: sponsor });
            expect(part.traderMargin).toBeGreaterThanOrEqual(0n);
            expect(part.sponsoredMargin).toBeGreaterThanOrEqual(0n);
            usedTrader += part.traderMargin;
            usedSponsor += part.sponsoredMargin;
            expect(usedTrader + part.remainingTraderMargin).toBe(trader);
            expect(usedSponsor + part.remainingSponsoredMargin).toBe(sponsor);
          }
          expect(usedTrader).toBe(trader);
          expect(usedSponsor).toBe(sponsor);
        }
      }
    }
  });
});
