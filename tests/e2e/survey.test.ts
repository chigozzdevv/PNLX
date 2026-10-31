import { describe, expect, test } from "bun:test";
import {
  emptySurveyAnswers, parseSurveyAnswers, parseSurveySubmission, surveyCsvCell,
  visibleSurveySteps, type SurveySubmission,
} from "@pnlx/survey";
import { Router } from "@/shared/http/router";
import { registerSurveyRoute } from "@/features/survey/survey.route";
import type { SurveyRepository } from "@/features/survey/survey.repository";
import { DEFAULT_PRODUCTION_WEB_ORIGINS, webOrigins } from "@/shared/http/cors";

const submissionId = "9cc3098c-a5ca-493e-8d7e-b5146e213123";
function validAnswers() {
  return { ...emptySurveyAnswers(), activity: "recent", products: ["perps"],
    platforms: ["bybit", "hyperliquid"], priorities: ["security", "privacy"],
    funding: ["crypto"], sources: ["own", "news"], privacy: "somewhat",
    requirements: ["demo", "liquidity"], stellar: "heard" };
}

function setup(repository?: SurveyRepository, now?: () => number) {
  const records = new Map<string, SurveySubmission>();
  // Check that survey submission explicitly bypasses wallet authentication.
  const router = new Router({ protectMutations: true, authenticate: () => new Response(null, { status: 401 }) });
  registerSurveyRoute(router, {
    allowedOrigins: webOrigins(DEFAULT_PRODUCTION_WEB_ORIGINS), now,
    repository: repository ?? { async save(submission) {
      if (records.has(submission.submissionId)) return false;
      records.set(submission.submissionId, submission); return true;
    } },
  });
  function request(body: unknown = { submissionId, answers: validAnswers() }, headers: Record<string, string> = {}) {
    return router.handle(new Request("https://api.pnl.family/survey/responses", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://www.pnl.family", ...headers }, body: JSON.stringify(body),
    }));
  }
  return { router, records, request };
}

describe("survey boundaries and branching", () => {
  test.each(["https://pnlx.trade", "https://www.pnlx.trade", "https://www.pnl.family", "https://pnl.family"])(
    "accepts survey submissions from the compatible frontend origin %s", async (origin) => {
      const { request, records } = setup();
      expect((await request(undefined, { origin })).status).toBe(201);
      expect(records.size).toBe(1);
    },
  );

  test("accepts several platforms, retaining only known answer fields", () => {
    const result = parseSurveySubmission({ submissionId, answers: { ...validAnswers(), wallet: "do not collect", $set: { admin: true } } });
    expect(result.errors).toEqual({});
    expect(result.submission?.answers.platforms).toEqual(["bybit", "hyperliquid"]);
    expect(result.submission?.answers).not.toHaveProperty("wallet");
    expect(result.submission?.answers).not.toHaveProperty("$set");
  });

  test("non-traders skip the experience step and stale trading answers are discarded", () => {
    const result = parseSurveyAnswers({ ...validAnswers(), activity: "never", products: ["invalid"], platformsOther: "stale", problem: "stale answer" });
    expect(result.errors).toEqual({});
    expect(visibleSurveySteps("never")).not.toContain("experience");
    expect(result.answers.products).toEqual([]);
    expect(result.answers.platformsOther).toBe("");
    expect(result.answers.problem).toBe("");
  });

  test("rejects unlisted options, duplicates, too many priorities and exclusive combinations", () => {
    const result = parseSurveyAnswers({ ...validAnswers(), platforms: ["fake"], products: ["spot", "spot"],
      priorities: ["security", "privacy", "speed", "cost"], sources: ["none", "ai"], requirements: ["none", "demo"] });
    for (const field of ["platforms", "products", "priorities", "sources", "requirements"] as const) expect(result.errors[field]).toBeDefined();
  });

  test("requires other text and bounds free text", () => {
    const result = parseSurveyAnswers({ ...validAnswers(), platforms: ["other"], problem: "x".repeat(1201) });
    expect(result.errors.platformsOther).toBeDefined();
    expect(result.errors.problem).toBeDefined();
  });

  test("accepts five trial requirements, rejects six and keeps the priority limit at three", () => {
    const requirements = ["liquidity", "fees", "review", "privacy", "withdrawals"];
    expect(parseSurveyAnswers({ ...validAnswers(), requirements }).errors).toEqual({});
    expect(parseSurveyAnswers({ ...validAnswers(), requirements: [...requirements, "demo"] }).errors.requirements).toBeDefined();
    expect(parseSurveyAnswers({ ...validAnswers(), priorities: ["security", "privacy", "speed", "cost"] }).errors.priorities).toBeDefined();
  });

  test("country is optional and accepts only countries from the dropdown", () => {
    expect(parseSurveyAnswers({ ...validAnswers(), country: "" }).errors).toEqual({});
    const result = parseSurveyAnswers({ ...validAnswers(), country: "NG" });
    expect(result.errors).toEqual({});
    expect(result.answers.country).toBe("NG");
    expect(parseSurveyAnswers({ ...validAnswers(), country: "Not a country" }).errors.country).toBeDefined();
  });

  test("never stores a contact without a selected follow-up purpose", () => {
    const result = parseSurveyAnswers({ ...validAnswers(), contact: "person@example.com", contactMethod: "email", followUp: [] });
    expect(result.errors).toEqual({});
    expect(result.answers.contact).toBe("");
    expect(result.answers.contactMethod).toBe("");
  });

  test("validates opted-in contact and preserves the individual purposes", () => {
    const bad = parseSurveyAnswers({ ...validAnswers(), followUp: ["testnet"], contact: "invalid" });
    expect(bad.errors.contact).toBeDefined();
    const good = parseSurveyAnswers({ ...validAnswers(), followUp: ["testnet", "interview"], contactMethod: "telegram", contact: "@pnlx_trader" });
    expect(good.errors).toEqual({});
    expect(good.answers.followUp).toEqual(["testnet", "interview"]);
    expect(good.answers.contact).toBe("@pnlx_trader");
  });

  test("rejects malformed identifiers and unbounded source metadata", () => {
    expect(parseSurveySubmission({ submissionId: "bad", answers: validAnswers() }).errors.form).toBeDefined();
    expect(parseSurveySubmission({ submissionId, answers: validAnswers(), source: "https://example.com/?email=someone@example.com" }).errors.form).toBeDefined();
  });
});

describe("public survey submission", () => {
  test("persists without a trading wallet and safely handles retries", async () => {
    const { request, records } = setup();
    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(200);
    expect(records.size).toBe(1);
    expect([...records.values()][0].answers.platforms).toEqual(["bybit", "hyperliquid"]);
  });

  test("invalid responses never reach storage", async () => {
    const { request, records } = setup();
    expect((await request({ submissionId, answers: {} })).status).toBe(400);
    expect(records.size).toBe(0);
  });

  test("storage failures return a retryable failure without exposing infrastructure details", async () => {
    const { request } = setup({ async save() { throw new Error("mongodb://sensitive-connection-string"); } });
    const response = await request();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).not.toHaveProperty("saved");
    expect(JSON.stringify(body)).not.toContain("mongodb");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects cross-origin requests, wrong content types and honeypot submissions", async () => {
    const { request, records } = setup();
    expect((await request(undefined, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await request(undefined, { "content-type": "text/plain" })).status).toBe(415);
    expect((await request({ submissionId, answers: validAnswers(), website: "spam" })).status).toBe(400);
    expect(records.size).toBe(0);
  });

  test("bounds streamed bodies even without a declared content length", async () => {
    const { request, records } = setup();
    const response = await request({ text: "a".repeat(20_000) });
    expect(response.status).toBe(413);
    expect(records.size).toBe(0);
  });

  test("rate limits repeated attempts and releases the limit after the window", async () => {
    let currentTime = 1000;
    const { request } = setup(undefined, () => currentTime);
    for (let i = 0; i < 12; i++) await request();
    const blocked = await request();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("600");
    currentTime += 600_001;
    expect((await request()).status).toBe(200);
  });

  test("does not expose responses over a public GET endpoint", async () => {
    const { router } = setup();
    expect((await router.handle(new Request("https://api.pnl.family/survey/responses"))).status).toBe(404);
  });
});

test("CSV cells escape formulas, leading whitespace, quotes and multiline answers", () => {
  expect(surveyCsvCell("=SUM(A1:A2)")).toBe('"\'=SUM(A1:A2)"');
  expect(surveyCsvCell("  +cmd")).toBe('"\'  +cmd"');
  expect(surveyCsvCell('@handle')).toBe('"\'@handle"');
  expect(surveyCsvCell('a "quote"\nnext line')).toBe('"a ""quote""\nnext line"');
});
