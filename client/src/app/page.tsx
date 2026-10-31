import { headers } from "next/headers";
import { TradingPage } from "@/components/trading-page";
import { LandingPage } from "@/components/landing/page";

export default async function Home() {
  const hostname = (await headers()).get("host")?.split(":")[0].toLowerCase();
  return hostname === "app.pnlx.trade" || hostname === "app.localhost"
    ? <TradingPage />
    : <LandingPage />;
}
