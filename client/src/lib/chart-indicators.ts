import type { ChartCandle } from "@/types/trading";

export type ChartIndicatorId = "sma" | "ema" | "bollinger" | "vwap" | "rsi" | "macd";

export interface IndicatorPoint {
  time: string;
  value: number;
}

export interface BollingerResult {
  lower: IndicatorPoint[];
  middle: IndicatorPoint[];
  upper: IndicatorPoint[];
}

export interface MacdResult {
  histogram: IndicatorPoint[];
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
}

export function sma(candles: ChartCandle[], period = 20): IndicatorPoint[] {
  return simpleMovingAverage(candles.map(({ close, time }) => ({ time, value: close })), period);
}

export function ema(candles: ChartCandle[], period = 20): IndicatorPoint[] {
  return exponentialMovingAverage(candles.map(({ close, time }) => ({ time, value: close })), period);
}

export function bollingerBands(
  candles: ChartCandle[],
  period = 20,
  standardDeviations = 2,
): BollingerResult {
  const result: BollingerResult = { lower: [], middle: [], upper: [] };
  if (period < 1) return result;

  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1);
    const mean = window.reduce((total, candle) => total + candle.close, 0) / period;
    const variance = window.reduce((total, candle) => total + (candle.close - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * standardDeviations;
    const time = candles[index].time;
    result.middle.push({ time, value: mean });
    result.upper.push({ time, value: mean + deviation });
    result.lower.push({ time, value: mean - deviation });
  }
  return result;
}

export function vwap(candles: ChartCandle[]): IndicatorPoint[] {
  const result: IndicatorPoint[] = [];
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const candle of candles) {
    if (!Number.isFinite(candle.volume) || candle.volume <= 0) continue;
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
    result.push({ time: candle.time, value: cumulativePriceVolume / cumulativeVolume });
  }
  return result;
}

export function rsi(candles: ChartCandle[], period = 14): IndicatorPoint[] {
  if (period < 1 || candles.length <= period) return [];
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = candles[index].close - candles[index - 1].close;
    averageGain += Math.max(delta, 0);
    averageLoss += Math.max(-delta, 0);
  }
  averageGain /= period;
  averageLoss /= period;

  const result: IndicatorPoint[] = [{
    time: candles[period].time,
    value: relativeStrength(averageGain, averageLoss),
  }];
  for (let index = period + 1; index < candles.length; index += 1) {
    const delta = candles[index].close - candles[index - 1].close;
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
    result.push({
      time: candles[index].time,
      value: relativeStrength(averageGain, averageLoss),
    });
  }
  return result;
}

export function macd(
  candles: ChartCandle[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const prices = candles.map(({ close, time }) => ({ time, value: close }));
  const fast = new Map(exponentialMovingAverage(prices, fastPeriod).map((point) => [point.time, point.value]));
  const slow = exponentialMovingAverage(prices, slowPeriod);
  const macdLine = slow.flatMap((point) => {
    const fastValue = fast.get(point.time);
    return fastValue === undefined ? [] : [{ time: point.time, value: fastValue - point.value }];
  });
  const signalLine = exponentialMovingAverage(macdLine, signalPeriod);
  const signalByTime = new Map(signalLine.map((point) => [point.time, point.value]));
  const histogram = macdLine.flatMap((point) => {
    const signalValue = signalByTime.get(point.time);
    return signalValue === undefined ? [] : [{ time: point.time, value: point.value - signalValue }];
  });
  return { histogram, macd: macdLine, signal: signalLine };
}

function simpleMovingAverage(points: IndicatorPoint[], period: number): IndicatorPoint[] {
  if (period < 1 || points.length < period) return [];
  const result: IndicatorPoint[] = [];
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    sum += points[index].value;
    if (index >= period) sum -= points[index - period].value;
    if (index >= period - 1) result.push({ time: points[index].time, value: sum / period });
  }
  return result;
}

function exponentialMovingAverage(points: IndicatorPoint[], period: number): IndicatorPoint[] {
  if (period < 1 || points.length < period) return [];
  const result: IndicatorPoint[] = [];
  const multiplier = 2 / (period + 1);
  let current = points.slice(0, period).reduce((total, point) => total + point.value, 0) / period;
  result.push({ time: points[period - 1].time, value: current });
  for (let index = period; index < points.length; index += 1) {
    current = (points[index].value - current) * multiplier + current;
    result.push({ time: points[index].time, value: current });
  }
  return result;
}

function relativeStrength(averageGain: number, averageLoss: number): number {
  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}
