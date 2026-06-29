import type { NextRequest } from "next/server";

const DEFAULT_MERKL_API_URL = "http://127.0.0.1:4000";

type RouteContext = {
  params: Promise<{ path: string[] }> | { path: string[] };
};

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyMerkl(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyMerkl(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxyMerkl(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxyMerkl(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxyMerkl(request, context);
}

async function proxyMerkl(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const target = new URL(path.join("/"), merklApiBase());
  target.search = request.nextUrl.search;

  const headers = new Headers();
  copyHeader(request.headers, headers, "accept");
  copyHeader(request.headers, headers, "authorization");
  copyHeader(request.headers, headers, "content-type");

  const response = await fetch(target, {
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    cache: "no-store",
    headers,
    method: request.method,
  });

  return new Response(response.body, {
    headers: responseHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
}

function merklApiBase(): string {
  const value = process.env.MERKL_API_URL ?? process.env.NEXT_PUBLIC_MERKL_API_URL ?? DEFAULT_MERKL_API_URL;
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
