import { describe, expect, test } from "bun:test";
import { hasCurrentTermsAcceptance, TERMS_VERSION } from "./terms";

describe("terms acceptance", () => {
  test("recognizes acceptance of the current terms", () => {
    expect(hasCurrentTermsAcceptance(JSON.stringify({ version: TERMS_VERSION, acceptedAt: "2026-11-02T12:00:00.000Z" }))).toBe(true);
  });

  test("requires acceptance again when the saved terms version differs", () => {
    expect(hasCurrentTermsAcceptance(JSON.stringify({ version: "previous-version", acceptedAt: "2026-11-01T12:00:00.000Z" }))).toBe(false);
  });

  test("does not treat missing or damaged browser storage as agreement", () => {
    for (const value of [null, "", "broken json", "null", "true", "[]", "{}", JSON.stringify({ acceptedAt: "2026-11-02" })]) {
      expect(hasCurrentTermsAcceptance(value)).toBe(false);
    }
  });
});
