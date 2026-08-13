import { describe, expect, test } from "bun:test";
import { bollingerBands, ema, macd, rsi, sma, vwap } from "@/lib/chart-indicators";
import type { ChartCandle } from "@/types/trading";

const candles = Array.from({ length: 40 }, (_, index): ChartCandle => ({
  close: index + 1,
  high: index + 2,
  low: index,
  open: index + 0.5,
  time: new Date((index + 1) * 60_000).toISOString(),
  volume: index + 1,
}));

describe("chart indicators", () => {
  test("calculates SMA and seeded EMA", () => {
    expect(sma(candles, 3).slice(0, 2).map((point) => point.value)).toEqual([2, 3]);
    expect(ema(candles, 3).slice(0, 3).map((point) => point.value)).toEqual([2, 3, 4]);
  });

  test("calculates population Bollinger bands", () => {
    const bands = bollingerBands(candles, 3, 2);
    expect(bands.middle[0].value).toBe(2);
    expect(bands.upper[0].value).toBeCloseTo(3.632993, 5);
    expect(bands.lower[0].value).toBeCloseTo(0.367007, 5);
  });

  test("weights VWAP by reported volume and omits zero-volume candles", () => {
    const points = vwap([
      { ...candles[0], close: 10, high: 11, low: 9, volume: 1 },
      { ...candles[1], close: 20, high: 21, low: 19, volume: 3 },
      { ...candles[2], volume: 0 },
    ]);
    expect(points.map((point) => point.value)).toEqual([10, 17.5]);
  });

  test("uses Wilder RSI smoothing and handles flat markets", () => {
    expect(rsi(candles, 14)[0].value).toBe(100);
    const flat = candles.map((candle) => ({ ...candle, close: 10 }));
    expect(rsi(flat, 14)[0].value).toBe(50);
  });

  test("returns aligned MACD, signal and histogram series", () => {
    const result = macd(candles);
    expect(result.macd[0].time).toBe(candles[25].time);
    expect(result.signal[0].time).toBe(candles[33].time);
    expect(result.histogram[0].value).toBeCloseTo(0, 10);
  });
});
