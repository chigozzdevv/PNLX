import { readFileSync } from "node:fs";

/** Public, human-readable execution facts only. Never pass private notes or signed payloads. */
export interface ExecutionEmailData {
  kind: "setup" | "opened" | "closed" | "failed" | "paused" | "resumed" | "completed";
  runId: string;
  cycleId?: string;
  walletAlias?: string;
  market?: string;
  side?: string;
  margin?: string;
  leverage?: string | number;
  size?: string;
  entryPrice?: string;
  exitPrice?: string;
  fees?: string;
  funding?: string;
  pnl?: string;
  plannedAt?: string;
  submittedAt?: string;
  matchedAt?: string;
  proofStartedAt?: string;
  proofCompletedAt?: string;
  settledAt?: string;
  holdUntil?: string;
  holdingDurationMs?: number;
  /** Durations in milliseconds. Keys become readable labels; undefined values are omitted. */
  timings?: Record<string, number | undefined>;
  txHashes?: { label: string; hash: string }[];
  proofJobId?: string;
  balances?: { USDC?: string; XLM?: string; proofCreditETH?: string };
  message?: string;
  timestamp: string;
}

export const PNLX_EMAIL_FROM = "PNLX <pnlx.updates@muwa.io>";

const RESEND_API = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 15_000;
const colors = {
  header: "#0c0c0b", accent: "#ff6b22", ink: "#ebe6dc",
  muted: "#a49f95", border: "#302e28", background: "#0c0c0b",
  positive: "#27d68b", negative: "#ef4560",
};
const events: Record<ExecutionEmailData["kind"], string> = {
  setup: "Updates connected", opened: "Position opened", closed: "Position closed",
  failed: "Execution alert", paused: "Run paused", resumed: "Run resumed", completed: "Run completed",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

/** Defense in depth: freeform error text must not accidentally forward credential/payload dumps. */
function publicText(value: unknown, maximumLength = 500): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (
    /\b(?:api[_ -]?key|secret(?:[_ -]?key)?|seed(?:[_ -]?phrase)?|mnemonic|(?:note[_ -]?)?witness(?:es)?|(?:raw[_ -]?)?(?:signed[_ -]?)?xdr)\s*[:=]/i.test(raw)
    || /\bS[A-Z2-7]{55}\b/.test(raw)
    || /\bre_[A-Za-z0-9_-]{10,}\b/.test(raw)
    || /\bBearer\s+\S+/i.test(raw)
    || /(?:^|[\s"':=])[A-Za-z0-9+/]{100,}={0,2}(?:$|[\s"',;}])/.test(raw)
  ) return undefined;
  const normalized = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1)}…`;
}

function time(value?: string): number | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function displayTime(value?: string): string | undefined {
  const milliseconds = time(value);
  if (milliseconds === undefined) return undefined;
  return new Date(milliseconds).toISOString().replace("T", " ").replace(/\.000Z$/, " UTC").replace(/Z$/, " UTC");
}

function duration(value: number): string {
  if (value < 1_000) return `${Number(value.toFixed(1))} ms`;
  if (value < 60_000) return `${Number((value / 1_000).toFixed(2))} s`;
  const seconds = Math.round(value / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", remainder ? `${remainder}s` : ""].filter(Boolean).join(" ") || "0 s";
}

function durationLabel(key: string): string | undefined {
  const label = publicText(key.replace(/(?:_?ms|Milliseconds)$/i, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "), 100);
  return label ? label[0]!.toUpperCase() + label.slice(1) : undefined;
}

type Row = { label: string; value: string; href?: string };

function addRow(rows: Row[], label: string, value: unknown): void {
  const safe = publicText(value);
  if (safe !== undefined) rows.push({ label, value: safe });
}

function section(title: string, rows: Row[]): string {
  if (!rows.length) return "";
  return `<tr><td class="pad" style="padding:20px 28px 0;">${title ? `<h2 style="margin:0 0 8px;font-size:12px;line-height:18px;font-weight:500;color:${colors.muted};">${escapeHtml(title)}</h2>` : ""}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;table-layout:fixed;">${rows.map((row) => `<tr><td valign="top" width="96" style="width:96px;padding:7px 12px 7px 0;font-size:13px;line-height:19px;color:${colors.muted};">${escapeHtml(row.label)}</td><td valign="top" align="left" style="padding:7px 0;font-size:13px;line-height:19px;color:${colors.ink};overflow-wrap:anywhere;">${row.href ? `<a href="${escapeHtml(row.href)}" style="color:${colors.accent};text-decoration:none;">${escapeHtml(row.value)}</a>` : escapeHtml(row.value)}</td></tr>`).join("")}</table></td></tr>`;
}

function pnlColor(value?: string): string {
  if (!value) return colors.ink;
  const normalized = value.trim().replace(/[−–]/g, "-");
  const magnitude = normalized.replace(/[^0-9.]/g, "");
  if (!magnitude || !Number.isFinite(Number(magnitude)) || Number(magnitude) === 0) return colors.ink;
  return normalized.includes("-") || /^\(.*\)$/.test(normalized) ? colors.negative : colors.positive;
}

export function renderExecutionEmail(data: ExecutionEmailData): { subject: string; html: string; text: string } {
  const title = events[data.kind];
  const market = publicText(data.market, 100);
  const timestamp = displayTime(data.timestamp) ?? "Time unavailable";
  const message = publicText(data.message, 320);
  const pnl = publicText(data.pnl);
  const subject = ["PNLX", title, market].filter(Boolean).join(" · ");
  const details: Row[] = [{ label: "Network", value: "Testnet" }];
  addRow(details, "Side", data.side);
  addRow(details, "Margin", data.margin);
  addRow(details, "Leverage", typeof data.leverage === "number" ? (Number.isFinite(data.leverage) ? `${data.leverage}×` : undefined) : data.leverage);
  addRow(details, "Size", data.size);
  addRow(details, "Entry", data.entryPrice);
  addRow(details, "Exit", data.exitPrice);
  addRow(details, "Fees", data.fees);
  addRow(details, "Funding", data.funding);
  const walletNumber = data.walletAlias?.match(/^pnlx-observation-[a-f0-9]{12}-(\d+)$/)?.[1];
  addRow(details, "Wallet", walletNumber ? `Wallet ${walletNumber}` : data.walletAlias);
  addRow(details, "Close due", displayTime(data.holdUntil));

  const timeline: Row[] = [];
  for (const [label, value] of [
    ["Submitted", data.submittedAt], ["Matched", data.matchedAt],
    ["Proof started", data.proofStartedAt], ["Proof completed", data.proofCompletedAt], ["Settled", data.settledAt],
  ] as const) addRow(timeline, label, displayTime(value));
  const durations: Row[] = [];
  const supplied = new Set<string>();
  for (const [key, value] of Object.entries(data.timings ?? {})) {
    const label = durationLabel(key);
    if (label && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      addRow(durations, label, duration(value)); supplied.add(label.toLowerCase());
    }
  }
  const measured = (label: string, start?: string, end?: string) => {
    const a = time(start), b = time(end);
    if (!supplied.has(label.toLowerCase()) && a !== undefined && b !== undefined && b >= a) addRow(durations, label, duration(b - a));
  };
  measured("Matching", data.submittedAt, data.matchedAt);
  measured("Proving", data.proofStartedAt, data.proofCompletedAt);
  measured("Execution time", data.submittedAt, data.settledAt);
  if (typeof data.holdingDurationMs === "number" && Number.isFinite(data.holdingDurationMs) && data.holdingDurationMs >= 0) addRow(durations, "Held for", duration(data.holdingDurationMs));
  const transactions: Row[] = [];
  for (const tx of data.txHashes ?? []) {
    const label = publicText(tx.label, 100);
    if (label && /^[0-9a-f]{64}$/i.test(tx.hash)) transactions.push({ label, value: "View transaction ↗", href: `https://stellar.expert/explorer/testnet/tx/${tx.hash}` });
  }
  const balances: Row[] = [];
  addRow(balances, "USDC", data.balances?.USDC);
  addRow(balances, "XLM", data.balances?.XLM);
  addRow(balances, "Proof credit · ETH", data.balances?.proofCreditETH);
  const result = data.kind === "closed" ? `<p style="margin:14px 0 0;color:${colors.muted};font-size:12px;line-height:18px;">Net P&amp;L</p><p style="margin:4px 0 0;color:${pnlColor(pnl)};font-size:30px;line-height:38px;font-weight:600;">${escapeHtml(pnl ?? "P&L unavailable")}</p>` : "";
  const intro = data.kind === "setup" ? "You’ll receive opens, closes and failure alerts here." : message;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(subject)}</title><style>@media only screen and (max-width:480px){.pad{padding-left:20px!important;padding-right:20px!important}}</style></head>
<body style="margin:0;padding:0;background:${colors.background};color:${colors.ink};font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${colors.background}"><tr><td align="center" style="padding:32px 16px;"><table role="presentation" width="400" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:400px;">
<tr><td class="pad" style="padding:26px 28px 22px;"><img src="cid:pnlx-logo" alt="PNLX" width="108" height="20" style="display:block;width:108px;height:20px;border:0;"></td></tr>
<tr><td class="pad" style="padding:0 28px;"><h1 style="margin:0;color:${colors.ink};font-size:24px;line-height:32px;font-weight:600;">${escapeHtml(title)}</h1>${market ? `<p style="margin:7px 0 0;color:${colors.accent};font-size:14px;line-height:21px;">${escapeHtml(market)}</p>` : ""}${result}${intro ? `<p style="margin:12px 0 0;color:${colors.muted};font-size:14px;line-height:22px;">${escapeHtml(intro)}</p>` : ""}</td></tr>
${section("", details)}${section("Execution", timeline)}${section("Timing", durations)}${section("", balances)}${section("", transactions)}
<tr><td class="pad" style="padding:22px 28px 24px;color:${colors.muted};font-size:11px;line-height:18px;">${escapeHtml(timestamp)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = ["PNLX", title, market, data.kind === "closed" ? `Net P&L: ${pnl ?? "Unavailable"}` : undefined,
    intro, ...[details, timeline, durations, balances, transactions].filter((rows) => rows.length).map((rows) => rows.map((row) => `${row.label}: ${row.href ?? row.value}`).join("\n")), timestamp].filter(Boolean).join("\n\n");
  return { subject, html, text };
}

export interface SendExecutionEmailOptions {
  apiKey: string;
  from: string;
  to: string | string[];
  data: ExecutionEmailData;
  /** Persist this with the event and reuse it unchanged for retries. Resend deduplicates for 24 hours. */
  idempotencyKey: string;
}

function validateApiKey(apiKey: string): void {
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error("A valid Resend API key is required.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resendRequest(apiKey: string, path: string, init: RequestInit, operation: string): Promise<Record<string, unknown>> {
  validateApiKey(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${RESEND_API}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } catch {
      throw new Error(controller.signal.aborted ? `Resend ${operation} timed out after 15 seconds.` : `Resend ${operation} failed before a response was received.`);
    }
    // Provider error bodies can echo recipient addresses, credentials, and request content.
    if (!response.ok) throw new Error(`Resend ${operation} failed (HTTP ${response.status}).`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(controller.signal.aborted ? `Resend ${operation} timed out after 15 seconds.` : `Resend ${operation} returned an unreadable response.`);
    }
    if (!isRecord(payload)) throw new Error(`Resend ${operation} returned an invalid response.`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export async function sendExecutionEmail(options: SendExecutionEmailOptions): Promise<{ id: string }> {
  const recipients = Array.isArray(options.to) ? options.to : [options.to];
  if (!options.from.trim() || /[\r\n]/.test(options.from) || recipients.length === 0 || recipients.length > 50 || recipients.some((recipient) => !recipient.trim() || /[\r\n]/.test(recipient))) {
    throw new Error("A sender and valid email recipients are required.");
  }
  if (!options.idempotencyKey.trim() || options.idempotencyKey.length > 256 || /[^\x21-\x7e]/.test(options.idempotencyKey)) {
    throw new Error("A printable Resend idempotency key of at most 256 characters is required.");
  }
  const rendered = renderExecutionEmail(options.data);
  const payload = await resendRequest(options.apiKey, "/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": options.idempotencyKey },
    body: JSON.stringify({ from: options.from, to: recipients, ...rendered,
      attachments: [{ filename: "pnlx-logo.png", content_id: "pnlx-logo",
        content: readFileSync(new URL("../../client/public/pnlx-logo.png", import.meta.url)).toString("base64") }],
    }),
  }, "email request");
  if (typeof payload.id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(payload.id)) throw new Error("Resend email request returned no valid email ID.");
  return { id: payload.id };
}

export interface ResendEmailStatus {
  id: string;
  /** A provider event, such as sent or delivered; undefined means the provider did not report one. */
  last_event?: string;
}

/** Read-only delivery lookup. Sending-only API keys may return HTTP 401/403. */
export async function fetchResendEmail(apiKey: string, id: string): Promise<ResendEmailStatus> {
  if (!/^[a-z0-9_-]{1,128}$/i.test(id)) throw new Error("A valid Resend email ID is required.");
  const payload = await resendRequest(apiKey, `/emails/${encodeURIComponent(id)}`, { method: "GET" }, "email status request");
  if (payload.id !== id) throw new Error("Resend email status request returned an unexpected email ID.");
  const lastEvent = typeof payload.last_event === "string" && /^[a-z_]{1,60}$/i.test(payload.last_event) ? payload.last_event : undefined;
  return { id, ...(lastEvent ? { last_event: lastEvent } : {}) };
}
