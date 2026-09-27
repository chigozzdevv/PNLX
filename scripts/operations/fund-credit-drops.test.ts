import { expect, test } from "bun:test";
import { creditDropHeadroom } from "./fund-credit-drops";

test("Drop funding stays within 10% of paid treasury fees and the shared treasury budget", () => {
  expect(creditDropHeadroom(1_000n, 0n, 0n)).toBe(100n);
  expect(creditDropHeadroom(1_000n, 80n, 60n)).toBe(40n);
  expect(creditDropHeadroom(1_000n, 950n, 0n)).toBe(50n);
  expect(creditDropHeadroom(1_000n, 950n, 50n)).toBe(0n);
  expect(creditDropHeadroom(1_000n, 800n, 100n)).toBe(0n);
});
