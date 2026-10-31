import { NextResponse, type NextRequest } from "next/server";

const APP_HOST = "app.pnlx.trade";
const SITE_HOSTS = new Set(["pnlx.trade", "www.pnlx.trade"]);

function isAppPath(pathname: string): boolean {
  return pathname === "/portfolio"
    || pathname.startsWith("/portfolio/")
    || pathname === "/liquidity"
    || pathname.startsWith("/liquidity/")
    || pathname === "/points"
    || pathname.startsWith("/points/")
    || pathname === "/rewards"
    || pathname.startsWith("/rewards/");
}

export function proxy(request: NextRequest) {
  const hostname = (request.headers.get("host") ?? request.nextUrl.hostname)
    .split(":")[0]
    .toLowerCase();
  const { pathname } = request.nextUrl;

  if (hostname === APP_HOST && pathname === "/survey") {
    const destination = request.nextUrl.clone();
    destination.hostname = "pnlx.trade";
    return NextResponse.redirect(destination, 308);
  }

  if (SITE_HOSTS.has(hostname) && isAppPath(pathname)) {
    const destination = request.nextUrl.clone();
    destination.protocol = "https:";
    destination.hostname = APP_HOST;
    return NextResponse.redirect(destination, 308);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon.ico|robots.txt|sitemap.xml).*)"],
};
