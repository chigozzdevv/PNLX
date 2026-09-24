import type { NextRequest } from "next/server";

export type PnlxRouteContext = { params: Promise<{ path: string[] }> };

export async function proxyPnlx(
  request: NextRequest,
  context: PnlxRouteContext,
  baseUrl: string | undefined,
): Promise<Response> {
  if (!baseUrl) return unavailable();
  const { path } = await context.params;
  let target: URL;
  try {
    target = new URL(path.join("/"), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    return unavailable();
  }
  target.search = request.nextUrl.search;

  const headers = new Headers();
  copyHeader(request.headers, headers, "accept");
  copyHeader(request.headers, headers, "authorization");
  copyHeader(request.headers, headers, "content-type");

  let response: Response;
  try {
    response = await fetch(target, {
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
      headers,
      method: request.method,
    });
  } catch {
    return unavailable();
  }

  if (response.headers.get("content-type")?.includes("text/html")) {
    await response.body?.cancel();
    return unavailable(response.ok ? 502 : response.status);
  }

  return new Response(response.body, {
    headers: responseHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}

function unavailable(status = 502): Response {
  return Response.json(
    { error: "Trading service temporarily unavailable" },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function copyHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);
  if (value) target.set(name, value);
}

function responseHeaders(source: Headers): Headers {
  const headers = new Headers();
  copyHeader(source, headers, "content-type");
  copyHeader(source, headers, "cache-control");
  return headers;
}
