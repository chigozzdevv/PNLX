import { createHash, randomBytes } from "node:crypto";
import { parseSurveySubmission, SURVEY_MAX_BYTES } from "@pnlx/survey";
import type { Router } from "@/shared/http/router";
import { webOrigins } from "@/shared/http/cors";
import { MongoSurveyRepository, type SurveyRepository } from "./survey.repository";

type SurveyRouteOptions = {
  uri?: string;
  database?: string;
  repository?: SurveyRepository;
  allowedOrigins?: ReadonlySet<string>;
  now?: () => number;
};

class SurveyHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function registerSurveyRoute(router: Router, options: SurveyRouteOptions): void {
  const repository = options.repository ?? new MongoSurveyRepository(options.uri ?? "", options.database ?? "pnlx");
  const origins = options.allowedOrigins ?? webOrigins(process.env.PNLX_WEB_ORIGINS ?? (
    process.env.NODE_ENV === "production"
      ? "https://www.pnl.family,https://pnl.family"
      : "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002"
  ));
  const now = options.now ?? Date.now;
  const salt = randomBytes(16).toString("hex");
  const requests = new Map<string, { count: number; expiresAt: number }>();

  const reply = (body: unknown, status: number, extraHeaders: Record<string, string> = {}) => Response.json(body, {
    status, headers: { "cache-control": "no-store", ...extraHeaders },
  });

  router.add("POST", "/survey/responses", async (request) => {
    const origin = request.headers.get("origin");
    if (origin && !origins.has(origin)) return reply({ error: "This survey request is not allowed." }, 403);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return reply({ error: "Send a JSON survey response." }, 415);
    }

    // Best-effort spam control. No IP addresses or these ephemeral keys enter the database.
    // Forwarded headers are not an identity or a one-person-one-response guarantee.
    const currentTime = now();
    for (const [key, entry] of requests) if (entry.expiresAt <= currentTime) requests.delete(key);
    const peer = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const key = createHash("sha256").update(`${salt}:${peer}`).digest("hex");
    const entry = requests.get(key);
    if ((entry && entry.count >= 12) || (!entry && requests.size >= 5000)) {
      return reply({ error: "Too many attempts. Please try again in a few minutes." }, 429, { "retry-after": "600" });
    }
    requests.set(key, { count: (entry?.count ?? 0) + 1, expiresAt: entry?.expiresAt ?? currentTime + 600_000 });

    let input: unknown;
    try {
      input = JSON.parse(await boundedBody(request));
    } catch (error) {
      return reply({ error: error instanceof SurveyHttpError ? error.message : "Invalid survey response." }, error instanceof SurveyHttpError ? error.status : 400);
    }
    if (input && typeof input === "object" && "website" in input && input.website) {
      return reply({ error: "Unable to accept this response." }, 400);
    }
    const parsed = parseSurveySubmission(input);
    if (!parsed.submission) return reply({ error: "Please check your answers.", fields: parsed.errors }, 400);
    try {
      const created = await repository.save(parsed.submission);
      return reply({ saved: true }, created ? 201 : 200);
    } catch {
      // Never return connection strings, database errors or respondent data to the browser/logs.
      return reply({ error: "We couldn’t save your response. Your answers are still here; please try again." }, 503);
    }
  }, { public: true });
}

async function boundedBody(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > SURVEY_MAX_BYTES) throw new SurveyHttpError(413, "Survey response is too large.");
  if (!request.body) throw new SurveyHttpError(400, "Survey response is missing.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > SURVEY_MAX_BYTES) {
        await reader.cancel();
        throw new SurveyHttpError(413, "Survey response is too large.");
      }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
