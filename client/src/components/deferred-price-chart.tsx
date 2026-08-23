"use client";

import type { Ref } from "react";
import {
  PriceChart,
  type PriceChartHandle,
  type PriceChartProps,
} from "@/components/price-chart";

interface DeferredPriceChartProps extends PriceChartProps {
  chartRef: Ref<PriceChartHandle>;
}

export function DeferredPriceChart({ chartRef, ...props }: DeferredPriceChartProps) {
  return <PriceChart {...props} ref={chartRef} />;
}
