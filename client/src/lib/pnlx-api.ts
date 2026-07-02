export async function pnlxPost<T>(
  path: string,
  data: unknown,
  token?: string,
): Promise<T> {
  return pnlxRequest<T>("POST", path, data, token);
}

export async function pnlxGet<T>(path: string, token?: string): Promise<T> {
  return pnlxRequest<T>("GET", path, undefined, token);
}

async function pnlxRequest<T>(
  method: "GET" | "POST",
  path: string,
  data?: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`/api/pnlx/${path.replace(/^\/+/, "")}`, {
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    method,
  });
  const text = await response.text();
  const body = parseBody(text);

  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : typeof body === "string" && body.trim()
          ? body.trim()
          : `PNLX API request failed with ${response.status}`;
    throw new Error(message);
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
