import { afterEach, describe, expect, test } from "bun:test";
import { apiPath } from "./api-path";

const env = process.env as Record<string, string | undefined>;
const original = { NODE_ENV: env.NODE_ENV, NEXT_PUBLIC_PNLX_API_URL: env.NEXT_PUBLIC_PNLX_API_URL };
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
});

describe("API domain routing", () => {
  test("uses the trade API for a production build without an explicit override", () => {
    env.NODE_ENV = "production";
    delete env.NEXT_PUBLIC_PNLX_API_URL;
    expect(apiPath("/markets")).toBe("https://api.pnlx.trade/markets");
  });

  test("preserves an explicitly configured endpoint, including the legacy API", () => {
    env.NODE_ENV = "production";
    env.NEXT_PUBLIC_PNLX_API_URL = "https://api.pnl.family/";
    expect(apiPath("/auth/challenge")).toBe("https://api.pnl.family/auth/challenge");
  });

  test("keeps local development routing unchanged", () => {
    env.NODE_ENV = "development";
    delete env.NEXT_PUBLIC_PNLX_API_URL;
    expect(apiPath("health")).toBe("http://127.0.0.1:4000/health");
  });
});
