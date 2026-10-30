import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  fetchResendEmail,
  PNLX_EMAIL_FROM,
  renderExecutionEmail,
  sendExecutionEmail,
  type ExecutionEmailData,
} from "./email";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function stubFetch(implementation: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) {
  const stub = mock(implementation);
  globalThis.fetch = Object.assign(stub, { preconnect: originalFetch.preconnect });
  return stub;
}

function data(overrides: Partial<ExecutionEmailData> = {}): ExecutionEmailData {
  return { kind: "opened", runId: "observation-20261030", timestamp: "2026-10-30T10:00:00.000Z", ...overrides };
}

function options() {
  return {
    apiKey: "re_mock_key_for_unit_tests",
    from: PNLX_EMAIL_FROM,
    to: "recipient@example.com",
    data: data(),
    idempotencyKey: "pnlx/observation-20261030/cycle-1/opened",
  };
}

describe("execution email rendering", () => {
  test("escapes every public field and strips subject control characters", () => {
    const rendered = renderExecutionEmail(data({
      runId: '<script>alert("run")</script>',
      cycleId: "cycle\r\nBcc: injected@example.com",
      walletAlias: 'Wallet <b title="unsafe">&\'</b>',
      market: '<img src=x onerror="alert(1)">',
      message: 'Execution <script>alert("message")</script> & checked.',
      timings: { '<script>alert("duration")</script>Ms': 42 },
    }));
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).not.toContain("<img src=x");
    expect(rendered.html + rendered.text + rendered.subject).not.toContain("alert(\"run\")");
    expect(rendered.html).toContain("&amp;&#39;");
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.text).toContain("Execution <script>");
  });

  test("omits absent fields and sections without inventing amounts or timings", () => {
    const rendered = renderExecutionEmail(data());
    for (const absent of ["Margin:", "Fees:", "Funding:", "Position size:", "Durations\n", "Execution timeline", "Proof job:", "Balances\n"]) {
      expect(rendered.text).not.toContain(absent);
    }
    expect(rendered.text).not.toContain("0 ms");
    expect(rendered.text).not.toContain("undefined");
    expect(rendered.text).not.toContain("null");
    expect(rendered.html).not.toContain("<pre");
    expect(rendered.html).not.toContain("<code");
    expect(rendered.text).not.toMatch(/operator|synthetic|wallet.vs.user/i);
  });

  test("unavailable P&L is distinct from a measured zero", () => {
    expect(renderExecutionEmail(data({ kind: "closed" })).text).toContain("Net P&L: Unavailable");
    const zero = renderExecutionEmail(data({ kind: "closed", pnl: "0.00 USDC", fees: "0 USDC", funding: "0 USDC", timings: { matchingMs: 0 } }));
    expect(zero.text).toContain("Net P&L: 0.00 USDC");
    expect(zero.text).toContain("Fees: 0 USDC");
    expect(zero.text).toContain("Funding: 0 USDC");
    expect(zero.text).toContain("Matching: 0 ms");
    expect(zero.html).toContain('color:#ebe6dc;font-size:30px');
  });

  test("colors close P&L by its reported sign without modifying its display", () => {
    for (const [pnl, color] of [["+1.25 USDC", "#27d68b"], ["−0.50 USDC", "#ef4560"], ["(0.40 USDC)", "#ef4560"], ["Unavailable", "#ebe6dc"]]) {
      const rendered = renderExecutionEmail(data({ kind: "closed", pnl }));
      expect(rendered.text).toContain(`Net P&L: ${pnl}`);
      expect(rendered.html).toContain(`color:${color};font-size:30px`);
    }
  });

  test("keeps real timeline timestamps separate from measured durations", () => {
    const rendered = renderExecutionEmail(data({
      plannedAt: "2026-10-30T09:59:59.000Z",
      submittedAt: "2026-10-30T10:00:00.000Z",
      matchedAt: "2026-10-30T10:00:01.250Z",
      proofStartedAt: "2026-10-30T10:00:03.000Z",
      proofCompletedAt: "2026-10-30T10:02:03.000Z",
      settledAt: "2026-10-30T10:02:04.500Z",
      holdingDurationMs: 3_600_000,
      timings: { queueMs: 20, unknownMs: undefined, invalidMs: -1, nanMs: NaN },
    }));
    expect(rendered.text).toContain("Matched: 2026-10-30 10:00:01.250 UTC");
    expect(rendered.text).toContain("Matching: 1.25 s");
    expect(rendered.text).toContain("Proving: 2m");
    expect(rendered.text).toContain("Held for: 1h");
    expect(rendered.text.indexOf("Submitted:")).toBeLessThan(rendered.text.indexOf("Matching:"));
    expect(rendered.text).not.toContain("Unknown:");
    expect(rendered.text).not.toContain("Invalid:");
    expect(rendered.text).not.toContain("Nan:");
  });

  test("does not derive durations from missing, invalid, or reversed timestamps", () => {
    const rendered = renderExecutionEmail(data({
      timestamp: "bad date", submittedAt: "2026-10-30T10:00:01Z", matchedAt: "2026-10-30T10:00:00Z",
      proofStartedAt: "invalid", proofCompletedAt: "2026-10-30T10:00:05Z",
    }));
    expect(rendered.text).toContain("Time unavailable");
    expect(rendered.text).not.toContain("Submitted to matched:");
    expect(rendered.text).not.toContain("Proof:");
    expect(rendered.text).not.toContain("NaN");
  });

  test("creates only validated Stellar Testnet transaction links", () => {
    const hash = "a".repeat(64);
    const rendered = renderExecutionEmail(data({ txHashes: [{ label: "Settlement & close", hash }, { label: "Invalid", hash: 'javascript:alert("x")' }] }));
    expect(rendered.html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${hash}"`);
    expect(rendered.html).toContain("Settlement &amp; close");
    expect(rendered.text).toContain(`Settlement & close: https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.text).not.toContain("Invalid:");
  });

  test("uses only the allowlisted fields and omits obvious private material", () => {
    const seed = `S${"A".repeat(55)}`;
    const rendered = renderExecutionEmail({
      ...data({ message: `secret_key=${seed}`, proofJobId: "re_very_private_api_key", walletAlias: seed }),
      witness: { nullifier: "PRIVATE_WITNESS_VALUE" },
      signedXdr: "PRIVATE_SIGNED_XDR_VALUE",
    } as ExecutionEmailData);
    expect(rendered.html + rendered.text).not.toContain(seed);
    expect(rendered.html + rendered.text).not.toContain("PRIVATE_");
    expect(rendered.html + rendered.text).not.toContain("re_very_private_api_key");
    expect(rendered.text).not.toContain("secret_key");
    const xdr = renderExecutionEmail(data({ message: `Signed payload: ${"A".repeat(200)}==` }));
    expect(xdr.text).not.toContain("A".repeat(100));
  });

  test("renders all lifecycle kinds and reports balances as supplied", () => {
    for (const kind of ["setup", "opened", "closed", "failed", "paused", "resumed", "completed"] as const) {
      const rendered = renderExecutionEmail(data({ kind, balances: { USDC: "12.340000", XLM: "0", proofCreditETH: "0.00017" } }));
      expect(rendered.subject).toStartWith("PNLX · ");
      expect(rendered.text).toContain("USDC: 12.340000");
      expect(rendered.text).toContain("XLM: 0");
      expect(rendered.text).toContain("Proof credit · ETH: 0.00017");
    }
  });

  test("setup acknowledges email connectivity without claiming the run is ready", () => {
    const rendered = renderExecutionEmail(data({ kind: "setup" }));
    expect(rendered.subject).toBe("PNLX · Updates connected");
    expect(rendered.text).toContain("You’ll receive opens, closes and failure alerts here.");
    expect(rendered.text).not.toContain("ready");
    expect(rendered.html).toContain('src="cid:pnlx-logo"');
    expect(rendered.html).toContain("#0c0c0b");
  });
});

test("keeps technical tracking references out of the visible email", () => {
  const result = renderExecutionEmail(data({ runId: "pnlx-hidden-run", cycleId: "pnlx-hidden-cycle", proofJobId: "pnlx-hidden-proof" }));
  const visible = result.subject + result.html + result.text;
  for (const internal of ["pnlx-hidden-run", "pnlx-hidden-cycle", "pnlx-hidden-proof", "Reference", "EXECUTION UPDATE", "Amounts and timings reflect"]) expect(visible).not.toContain(internal);
});

describe("Resend delivery helper (mocked; no real email)", () => {
  test("posts both representations with the stable provider deduplication header and a timeout signal", async () => {
    let capturedUrl: string | undefined;
    let captured: RequestInit | undefined;
    stubFetch(async (url, init) => { capturedUrl = String(url); captured = init; return Response.json({ id: "email_123" }); });
    await expect(sendExecutionEmail(options())).resolves.toEqual({ id: "email_123" });
    expect(capturedUrl).toBe("https://api.resend.com/emails");
    const headers = new Headers(captured?.headers);
    expect(headers.get("Idempotency-Key")).toBe(options().idempotencyKey);
    expect(headers.get("Authorization")).toBe(`Bearer ${options().apiKey}`);
    expect(captured?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(captured?.body));
    expect(body.from).toBe("PNLX <pnlx.updates@muwa.io>");
    expect(body.to).toEqual(["recipient@example.com"]);
    expect(body.html).toContain("<!doctype html>");
    expect(body.text).toContain("Position opened");
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0].content_id).toBe("pnlx-logo");
    expect(Buffer.from(body.attachments[0].content, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(body).not.toHaveProperty("apiKey");
    expect(body).not.toHaveProperty("idempotencyKey");
  });

  test("keeps the same idempotency key on retries", async () => {
    const keys: (string | null)[] = [];
    stubFetch(async (_url, init) => { keys.push(new Headers(init?.headers).get("Idempotency-Key")); return Response.json({ id: "same_email_id" }); });
    expect(await sendExecutionEmail(options())).toEqual(await sendExecutionEmail(options()));
    expect(keys).toEqual([options().idempotencyKey, options().idempotencyKey]);
  });

  test("does not surface provider error bodies or network exception secrets", async () => {
    stubFetch(async () => Response.json({ message: `Invalid ${options().apiKey} recipient@example.com`, name: "validation_error" }, { status: 422 }));
    await expect(sendExecutionEmail(options())).rejects.toThrow("Resend email request failed (HTTP 422).");
    stubFetch(async () => { throw new Error(`Leaked ${options().apiKey} recipient@example.com`); });
    await expect(sendExecutionEmail(options())).rejects.toThrow("Resend email request failed before a response was received.");
  });

  test("sanitizes malformed success responses", async () => {
    stubFetch(async () => new Response("private malformed response body", { status: 200 }));
    await expect(sendExecutionEmail(options())).rejects.toThrow("Resend email request returned an unreadable response.");
    stubFetch(async () => Response.json({ id: "<secret>" }));
    await expect(sendExecutionEmail(options())).rejects.toThrow("Resend email request returned no valid email ID.");
  });

  test("aborts at the bounded timeout and sanitizes the resulting exception", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler) => originalSetTimeout(handler, 0)) as typeof setTimeout);
    stubFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(`PRIVATE ${options().apiKey}`)), { once: true });
    }));
    try {
      await expect(sendExecutionEmail(options())).rejects.toThrow("Resend email request timed out after 15 seconds.");
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), 15_000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("rejects invalid input before any external request", async () => {
    const mockedFetch = stubFetch(async () => Response.json({ id: "unused" }));
    await expect(sendExecutionEmail({ ...options(), idempotencyKey: "bad\r\nkey" })).rejects.toThrow("idempotency key");
    await expect(sendExecutionEmail({ ...options(), to: [] })).rejects.toThrow("recipients");
    await expect(sendExecutionEmail({ ...options(), from: "PNLX\r\nBcc: other@example.com" })).rejects.toThrow("recipients");
    await expect(sendExecutionEmail({ ...options(), apiKey: "" })).rejects.toThrow("API key");
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test("returns only delivery metadata, without email body or recipient details", async () => {
    stubFetch(async () => Response.json({ id: "email_123", last_event: "delivered", html: "PRIVATE_BODY", to: ["recipient@example.com"] }));
    await expect(fetchResendEmail(options().apiKey, "email_123")).resolves.toEqual({ id: "email_123", last_event: "delivered" });
    stubFetch(async () => Response.json({ id: "email_123" }));
    await expect(fetchResendEmail(options().apiKey, "email_123")).resolves.toEqual({ id: "email_123" });
  });

  test("surfaces sanitized permission failures for restricted sending keys", async () => {
    stubFetch(async () => Response.json({ message: `Restricted key ${options().apiKey}` }, { status: 403 }));
    await expect(fetchResendEmail(options().apiKey, "email_123")).rejects.toThrow("Resend email status request failed (HTTP 403).");
  });
});
