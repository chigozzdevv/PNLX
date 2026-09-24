import { describe, expect, it } from "bun:test";
import { apiPathForStack, stackForPathname } from "./api-stack";

describe("API stack routing", () => {
  it("keeps previous positions on the old API and current trading on the new API", () => {
    expect(stackForPathname("/legacy/portfolio")).toBe("legacy");
    expect(stackForPathname("/portfolio")).toBe("current");
    expect(apiPathForStack("/position-closes/manual-proven", "legacy"))
      .toBe("/api/pnlx-legacy/position-closes/manual-proven");
    expect(apiPathForStack("/intents", "current")).toBe("/api/pnlx/intents");
  });
});
