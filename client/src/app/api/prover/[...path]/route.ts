import type { NextRequest } from "next/server";

const DEFAULT_PNLX_PROVER_URL = "http://127.0.0.1:4101";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyProver(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyProver(request, context);
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

async function proxyProver(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const target = new URL(path.join("/"), proverBase());
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : "fetch failed";
    return Response.json(
      { error: `PNLX prover unavailable at ${target.origin}: ${detail}` },
      { status: 502 },
    );
  }

  return new Response(response.body, {
    headers: responseHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}

function proverBase(): string {
  const value = process.env.PNLX_PROVER_URL ?? DEFAULT_PNLX_PROVER_URL;
  return value.endsWith("/") ? value : `${value}/`;
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
