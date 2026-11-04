import { NextResponse, type NextRequest } from "next/server";

const SITE_HOSTS = new Set(["pnlx.trade", "www.pnlx.trade"]);

export function proxy(request: NextRequest) {
  const hostname = (request.headers.get("host") ?? request.nextUrl.hostname)
    .split(":")[0]
    .toLowerCase();

  if (SITE_HOSTS.has(hostname) && request.nextUrl.pathname === "/trade") {
    const destination = request.nextUrl.clone();
    destination.protocol = "https:";
    destination.hostname = "app.pnlx.trade";
    destination.port = "";
    destination.pathname = "/";
    return NextResponse.redirect(destination, 308);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/trade"],
};
