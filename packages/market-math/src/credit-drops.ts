const U128_MAX = (1n << 128n) - 1n;

export interface CreditDropCloseSplit {
  traderAmount: bigint;
  reserveAmount: bigint;
  reserveLoss: bigint;
}

export function splitCreditDropClose(netEquity: bigint, sponsoredPrincipal: bigint): CreditDropCloseSplit {
  assertAmount(netEquity);
  assertAmount(sponsoredPrincipal);
  const reserveAmount = netEquity < sponsoredPrincipal ? netEquity : sponsoredPrincipal;
  return {
    traderAmount: netEquity - reserveAmount,
    reserveAmount,
    reserveLoss: sponsoredPrincipal - reserveAmount,
  };
}

export interface CreditDropAllocation {
  traderMargin: bigint;
  sponsoredMargin: bigint;
  remainingTraderMargin: bigint;
  remainingSponsoredMargin: bigint;
}

export function allocateCreditDropFill(input: {
  orderSize: bigint;
  filledSize: bigint;
  fillSize: bigint;
  traderMargin: bigint;
  sponsoredMargin: bigint;
}): CreditDropAllocation {
  for (const amount of Object.values(input)) assertAmount(amount);
  const { orderSize, filledSize, fillSize, traderMargin, sponsoredMargin } = input;
  if (orderSize === 0n || fillSize === 0n || filledSize + fillSize > orderSize) {
    throw new Error("Invalid Credit Drop fill size");
  }
  const total = traderMargin + sponsoredMargin;
  assertAmount(total);
  if (total === 0n) throw new Error("Credit Drop fill has no margin");
  const before = cumulativeMargin(total, filledSize, orderSize);
  const after = cumulativeMargin(total, filledSize + fillSize, orderSize);
  const sponsorBefore = sponsoredMargin * before / total;
  const sponsorAfter = sponsoredMargin * after / total;
  const allocatedSponsor = sponsorAfter - sponsorBefore;
  const allocatedTrader = after - before - allocatedSponsor;
  return {
    traderMargin: allocatedTrader,
    sponsoredMargin: allocatedSponsor,
    remainingTraderMargin: traderMargin - (after - sponsorAfter),
    remainingSponsoredMargin: sponsoredMargin - sponsorAfter,
  };
}

export function creditDropContribution(requiredMargin: bigint, availableCredit: bigint): {
  traderMargin: bigint;
  sponsoredMargin: bigint;
} {
  assertAmount(requiredMargin);
  assertAmount(availableCredit);
  if (requiredMargin === 0n) throw new Error("Credit Drop requires margin");
  const sponsoredMargin = availableCredit < requiredMargin ? availableCredit : requiredMargin;
  return { traderMargin: requiredMargin - sponsoredMargin, sponsoredMargin };
}

function cumulativeMargin(amount: bigint, filledSize: bigint, orderSize: bigint): bigint {
  return (amount * filledSize + orderSize - 1n) / orderSize;
}

function assertAmount(amount: bigint): void {
  if (amount < 0n || amount > U128_MAX) throw new Error("Invalid Credit Drop amount");
}
