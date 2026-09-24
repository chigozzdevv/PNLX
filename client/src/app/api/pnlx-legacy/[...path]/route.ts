import type { NextRequest } from "next/server";
import { proxyPnlx, type PnlxRouteContext } from "@/lib/pnlx-proxy";

export async function GET(request: NextRequest, context: PnlxRouteContext) {
  return proxyPnlx(request, context, process.env.PNLX_LEGACY_API_URL);
}

export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
