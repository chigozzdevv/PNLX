import type { ChartCandle } from "@/types/trading";

export interface ChartVolumePoint {
  color: string;
  time: string;
  value: number;
}

const UP_VOLUME_COLOR = "rgba(40, 213, 143, 0.48)";
const DOWN_VOLUME_COLOR = "rgba(241, 83, 103, 0.48)";
const EMPTY_VOLUME_COLOR = "rgba(0, 0, 0, 0)";

export function chartVolumeData(candles: ChartCandle[]): ChartVolumePoint[] {
  const points = candles.map((candle) => {
    const value = Number.isFinite(candle.volume) ? Math.max(0, candle.volume) : 0;
    return {
      color: value === 0
        ? EMPTY_VOLUME_COLOR
        : candle.close >= candle.open
          ? UP_VOLUME_COLOR
          : DOWN_VOLUME_COLOR,
      time: candle.time,
      value,
    };
  });

  return points.some((point) => point.value > 0) ? points : [];
}
