import { Suspense } from "react";
import { LiquidityPoolDetails } from "@/components/liquidity-pool-details";

export default function LiquidityPoolPage() {
  return <Suspense><LiquidityPoolDetails /></Suspense>;
}
