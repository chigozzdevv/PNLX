import { describe, expect, test } from "bun:test";
import {
  formatSignedSettlementUsd,
  formatUsdc,
  settlementAmountSign,
} from "@/lib/format";

describe("settlement amount formatting", () => {
  test("keeps ordinary returned margin compact and USDC-denominated", () => {
    expect(formatUsdc(0.19)).toBe("0.19");
    expect(formatUsdc(12)).toBe("12.00");
  });

  test("preserves nonzero values through USDC's seven-decimal precision", () => {
    expect(formatUsdc(0.004)).toBe("0.004");
    expect(formatSignedSettlementUsd(0.004)).toBe("+$0.004");
    expect(formatSignedSettlementUsd(-0.0000001)).toBe("−$0.0000001");
  });

  test("does not show a sign when the displayed value rounds to zero", () => {
    expect(formatSignedSettlementUsd(0)).toBe("$0.00");
    expect(formatSignedSettlementUsd(0.00000004)).toBe("$0.00");
    expect(formatSignedSettlementUsd(-0.00000004)).toBe("$0.00");
    expect(settlementAmountSign(-0.00000004)).toBe(0);
  });
});
