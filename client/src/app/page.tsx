import type { Metadata } from "next";
import { headers } from "next/headers";
import { TradingPage } from "@/components/trading-page";
import { LandingPage } from "@/components/landing/page";

async function isTradingHost() {
  const hostname = (await headers()).get("host")?.split(":")[0].toLowerCase();
  return hostname === "app.pnlx.trade" || hostname === "app.localhost";
}

export async function generateMetadata(): Promise<Metadata> {
  if (await isTradingHost()) return {};
  return {
    title: "PNLX | Usual markets, now private",
    description: "Trade perpetuals with private orders and proof-backed settlement on Stellar.",
  };
}

export default async function Home() {
  return (await isTradingHost()) ? <TradingPage /> : <LandingPage />;
}
