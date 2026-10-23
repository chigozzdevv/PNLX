import { apiPath } from "@/lib/api-path";

export class PnlxApiError extends Error {
  constructor(message: string, readonly status: number, readonly submissionRejected = false) {
    super(message);
    this.name = "PnlxApiError";
  }
}

export async function pnlxPost<T>(
  path: string,
  data: unknown,
  token?: string,
): Promise<T> {
  return pnlxRequest<T>("POST", path, data, token);
}

export async function pnlxGet<T>(path: string, token?: string, signal?: AbortSignal): Promise<T> {
  return pnlxRequest<T>("GET", path, undefined, token, signal);
}

function stringifyBody(data: unknown): string {
  return JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

async function pnlxRequest<T>(
  method: "GET" | "POST",
  path: string,
  data?: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  const requestBody = data === undefined ? undefined : stringifyBody(data);
  let response: Response;
  let text: string;
  try {
    response = await fetch(apiPath(path), {
      body: requestBody,
      cache: "no-store",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
      signal,
    });
    text = await response.text();
  } catch {
    throw new Error("Trading service temporarily unavailable");
  }
  const body = parseBody(text);

  // Gateway pages can also arrive with a successful HTTP status.
  if (typeof body === "string" || response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("Trading service temporarily unavailable");
  }

  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string" &&
      !/<\/?[a-z][^>]*>|<!doctype/i.test((body as { error: string }).error)
        ? (body as { error: string }).error
        : "Trading service temporarily unavailable";
    const submissionRejected = Boolean(body && typeof body === "object" && "submissionRejected" in body && body.submissionRejected === true);
    throw new PnlxApiError(message, response.status, submissionRejected);
  }

  return body as T;
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
