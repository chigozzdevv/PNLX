import { allocateCreditDropFill, creditDropContribution, splitCreditDropClose } from "@pnlx/market-math";
import { hashFields } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";

export interface CreditDropTerms {
  amount: bigint;
}

export interface CreditDropOrder {
  commitment: Hex;
  size: bigint;
  filledSize: bigint;
  traderMargin: bigint;
  sponsoredMargin: bigint;
  remainingSponsoredMargin: bigint;
}

export interface CreditDropPosition {
  principal: bigint;
  reserveReturn?: bigint;
  settlementId?: Hex;
}

export interface CreditDropState {
  terms: CreditDropTerms;
  available: bigint;
  returned: bigint;
  loss: bigint;
  used: boolean;
  order: CreditDropOrder | null;
  positions: Record<Hex, CreditDropPosition>;
  applied: Hex[];
}

export function createCreditDrop(terms: CreditDropTerms): CreditDropState {
  if (terms.amount <= 0n || terms.amount >= (1n << 128n)) {
    throw new Error("Invalid Credit Drop terms");
  }
  return { terms: { ...terms }, available: terms.amount, returned: 0n, loss: 0n,
    used: false, order: null, positions: {}, applied: [] };
}

export function reserveCreditDrop(state: CreditDropState, input: {
  commitment: Hex; size: bigint; requiredMargin: bigint;
}): CreditDropState {
  assertCreditDropConservation(state);
  assertId(input.commitment);
  if (state.order || state.used || state.available === 0n) throw new Error("Credit Drop is not available");
  if (input.size <= 0n || input.size >= (1n << 128n)) throw new Error("Invalid order size");
  const { traderMargin, sponsoredMargin } = creditDropContribution(input.requiredMargin, state.available);
  const next = structuredClone(state);
  next.available -= sponsoredMargin;
  next.order = { commitment: input.commitment, size: input.size, filledSize: 0n,
    traderMargin, sponsoredMargin, remainingSponsoredMargin: sponsoredMargin };
  assertCreditDropConservation(next);
  return next;
}

export function fillCreditDrop(state: CreditDropState, input: {
  orderCommitment: Hex; positionCommitment: Hex; fillSize: bigint; settlementId: Hex;
  residualCommitment?: Hex;
}): CreditDropState {
  assertCreditDropConservation(state);
  assertId(input.positionCommitment);
  assertId(input.settlementId);
  const eventId = hashFields("credit-drop-fill", [input.settlementId, input.positionCommitment]);
  if (state.applied.includes(eventId)) throw new Error("Credit Drop settlement already applied");
  const order = matchingOrder(state, input.orderCommitment);
  if (state.positions[input.positionCommitment]) throw new Error("Position already has Credit Drop principal");
  const allocation = allocateCreditDropFill({ ...order, fillSize: input.fillSize, orderSize: order.size });
  const filledSize = order.filledSize + input.fillSize;
  if ((filledSize < order.size) !== Boolean(input.residualCommitment)) throw new Error("Credit Drop residual mismatch");
  if (input.residualCommitment) {
    assertId(input.residualCommitment);
    if (input.residualCommitment === order.commitment) throw new Error("Credit Drop residual must advance");
  }
  const next = structuredClone(state);
  if (allocation.sponsoredMargin > 0n && !next.used) {
    next.used = true;
    next.returned += next.available;
    next.available = 0n;
  }
  next.positions[input.positionCommitment] = { principal: allocation.sponsoredMargin };
  next.applied.push(eventId);
  next.order = input.residualCommitment ? { ...order, commitment: input.residualCommitment,
    filledSize, remainingSponsoredMargin: allocation.remainingSponsoredMargin } : null;
  assertCreditDropConservation(next);
  return next;
}

export function cancelCreditDrop(state: CreditDropState, commitment: Hex): CreditDropState {
  assertCreditDropConservation(state);
  const order = matchingOrder(state, commitment);
  const next = structuredClone(state);
  next.order = null;
  if (!state.used) next.available += order.remainingSponsoredMargin;
  else next.returned += order.remainingSponsoredMargin;
  assertCreditDropConservation(next);
  return next;
}

export function closeCreditDrop(state: CreditDropState, input: {
  positionCommitment: Hex; netEquity: bigint; settlementId: Hex;
}): { state: CreditDropState; traderAmount: bigint; reserveAmount: bigint } {
  assertCreditDropConservation(state);
  assertId(input.settlementId);
  const position = state.positions[input.positionCommitment];
  if (!position) throw new Error("Sponsored position is not recorded");
  const eventId = hashFields("credit-drop-close", [input.settlementId, input.positionCommitment]);
  if (position.settlementId || state.applied.includes(eventId)) throw new Error("Sponsored position already settled");
  const split = splitCreditDropClose(input.netEquity, position.principal);
  const next = structuredClone(state);
  next.positions[input.positionCommitment] = { ...position, reserveReturn: split.reserveAmount,
    settlementId: input.settlementId };
  next.applied.push(eventId);
  next.returned += split.reserveAmount;
  next.loss += split.reserveLoss;
  assertCreditDropConservation(next);
  return { state: next, traderAmount: split.traderAmount, reserveAmount: split.reserveAmount };
}

export function assertCreditDropConservation(state: CreditDropState): void {
  const outstanding = Object.values(state.positions).filter((position) => !position.settlementId)
    .reduce((sum, position) => sum + position.principal, 0n);
  const amounts = [state.available, state.returned, state.loss, outstanding,
    state.order?.remainingSponsoredMargin ?? 0n];
  if (amounts.some((amount) => amount < 0n) || amounts.reduce((a, b) => a + b, 0n) !== state.terms.amount) {
    throw new Error("Credit Drop principal does not reconcile");
  }
}

function matchingOrder(state: CreditDropState, commitment: Hex): CreditDropOrder {
  if (!state.order || state.order.commitment !== commitment) throw new Error("Credit Drop order mismatch");
  return state.order;
}

function assertId(id: Hex): void {
  if (!/^0x[0-9a-f]{64}$/.test(id) || BigInt(id) === 0n) throw new Error("Invalid Credit Drop commitment");
}
