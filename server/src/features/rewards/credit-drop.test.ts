import { describe, expect, test } from "bun:test";
import type { Hex } from "@pnlx/protocol-types";
import { cancelCreditDrop, closeCreditDrop, createCreditDrop, fillCreditDrop,
  reserveCreditDrop } from "./credit-drop";

const id = (value: number): Hex => `0x${value.toString(16).padStart(64, "0")}`;
const terms = { amount: 10n };
const order = { commitment: id(1), size: 100n, requiredMargin: 100n };

describe("Credit Drop lifecycle", () => {
  test("only one order can reserve a grant and cancellation restores unused credit", () => {
    const initial = createCreditDrop(terms);
    const reserved = reserveCreditDrop(initial, order);
    expect(initial.available).toBe(10n);
    expect(reserved.available).toBe(0n);
    expect(reserved.order?.traderMargin).toBe(90n);
    expect(reserved.order?.sponsoredMargin).toBe(10n);
    expect(() => reserveCreditDrop(reserved, { ...order, commitment: id(2) })).toThrow();
    expect(() => cancelCreditDrop(reserved, id(2))).toThrow();
    const cancelled = cancelCreditDrop(reserved, id(1));
    expect(cancelled.available).toBe(10n);
    expect(cancelled.returned).toBe(0n);
    expect(reserveCreditDrop(cancelled, { ...order, commitment: id(2) }).order?.commitment).toBe(id(2));
  });

  test("a partial fill consumes the grant; cancelled unused principal returns to reserve", () => {
    const reserved = reserveCreditDrop(createCreditDrop(terms), order);
    const filled = fillCreditDrop(reserved, { orderCommitment: id(1), positionCommitment: id(3),
      fillSize: 40n, residualCommitment: id(2), settlementId: id(10) });
    expect(filled.positions[id(3)].principal).toBe(4n);
    expect(filled.order?.remainingSponsoredMargin).toBe(6n);
    const cancelled = cancelCreditDrop(filled, id(2));
    expect(cancelled.returned).toBe(6n);
    expect(cancelled.available).toBe(0n);
    expect(() => reserveCreditDrop(cancelled, { ...order, commitment: id(4) })).toThrow();
    const closed = closeCreditDrop(cancelled, { positionCommitment: id(3), netEquity: 2n, settlementId: id(11) });
    expect(closed.traderAmount).toBe(0n);
    expect(closed.reserveAmount).toBe(2n);
    expect(closed.state.returned).toBe(8n);
    expect(closed.state.loss).toBe(2n);
    expect(() => closeCreditDrop(closed.state, { positionCommitment: id(3), netEquity: 2n,
      settlementId: id(12) })).toThrow();
  });

  test("several fills in one settlement preserve principal and cannot replay", () => {
    let state = reserveCreditDrop(createCreditDrop(terms), order);
    state = fillCreditDrop(state, { orderCommitment: id(1), positionCommitment: id(3),
      fillSize: 40n, residualCommitment: id(2), settlementId: id(10) });
    expect(() => fillCreditDrop(state, { orderCommitment: id(2), positionCommitment: id(3),
      fillSize: 60n, settlementId: id(10) })).toThrow();
    state = fillCreditDrop(state, { orderCommitment: id(2), positionCommitment: id(4),
      fillSize: 60n, settlementId: id(10) });
    expect(state.positions[id(3)].principal + state.positions[id(4)].principal).toBe(10n);
    expect(state.order).toBeNull();
    state = closeCreditDrop(state, { positionCommitment: id(4), netEquity: 50n, settlementId: id(11) }).state;
    state = closeCreditDrop(state, { positionCommitment: id(3), netEquity: 40n, settlementId: id(11) }).state;
    expect(state.returned).toBe(10n);
    expect(state.loss).toBe(0n);
  });

  test("a fill with no sponsored principal does not consume the Drop", () => {
    const reserved = reserveCreditDrop(createCreditDrop({ ...terms, amount: 1n }), order);
    const first = fillCreditDrop(reserved, { orderCommitment: id(1), positionCommitment: id(3),
      fillSize: 1n, residualCommitment: id(2), settlementId: id(10) });
    expect(first.positions[id(3)].principal).toBe(0n);
    expect(first.used).toBe(false);
    const cancelled = cancelCreditDrop(first, id(2));
    expect(cancelled.available).toBe(1n);
    expect(cancelled.returned).toBe(0n);
  });

  test("a Drop can cover the full margin and return only the remaining equity on close", () => {
    const reserved = reserveCreditDrop(createCreditDrop({ ...terms, amount: 120n }), order);
    expect(reserved.order?.traderMargin).toBe(0n);
    expect(reserved.order?.sponsoredMargin).toBe(100n);
    expect(reserved.available).toBe(20n);
    const filled = fillCreditDrop(reserved, { orderCommitment: id(1), positionCommitment: id(3),
      fillSize: 100n, settlementId: id(10) });
    expect(filled.positions[id(3)].principal).toBe(100n);
    expect(filled.returned).toBe(20n);
    const closed = closeCreditDrop(filled, { positionCommitment: id(3), netEquity: 80n, settlementId: id(11) });
    expect(closed.traderAmount).toBe(0n);
    expect(closed.reserveAmount).toBe(80n);
    expect(closed.state.loss).toBe(20n);
    expect(closed.state.returned).toBe(100n);
  });

  test("unused grant excess returns to reserve on first fill", () => {
    const reserved = reserveCreditDrop(createCreditDrop({ ...terms, amount: 50n }),
      { ...order, requiredMargin: 10n });
    expect(reserved.available).toBe(40n);
    const filled = fillCreditDrop(reserved, { orderCommitment: id(1), positionCommitment: id(3),
      fillSize: 100n, settlementId: id(10) });
    expect(filled.returned).toBe(40n);
    expect(filled.available).toBe(0n);
  });
});
