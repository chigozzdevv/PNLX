"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  bollingerBands,
  ema,
  macd,
  rsi,
  sma,
  vwap,
  type ChartIndicatorId,
  type IndicatorPoint,
} from "@/lib/chart-indicators";
import { ChartTools } from "@/components/chart-tools";
import { chartVolumeData } from "@/lib/chart-volume";
import { latestLogicalRange } from "@/lib/chart-range";
import { formatNumber } from "@/lib/format";
import type { ChartCandle, MarketDisplay } from "@/types/trading";

interface PriceChartProps {
  candles: ChartCandle[];
  drawingScope: string;
  indicators: ChartIndicatorId[];
  market: MarketDisplay;
  onLoadOlder: () => Promise<void>;
}

export interface PriceChartHandle {
  reset: () => void;
  toggleFullscreen: () => void;
}

interface ChartSeries {
  bollingerLower?: ISeriesApi<"Line">;
  bollingerMiddle?: ISeriesApi<"Line">;
  bollingerUpper?: ISeriesApi<"Line">;
  candles: ISeriesApi<"Candlestick">;
  ema?: ISeriesApi<"Line">;
  macd?: ISeriesApi<"Line">;
  macdHistogram?: ISeriesApi<"Histogram">;
  macdSignal?: ISeriesApi<"Line">;
  rsi?: ISeriesApi<"Line">;
  sma?: ISeriesApi<"Line">;
  volume?: ISeriesApi<"Histogram">;
  vwap?: ISeriesApi<"Line">;
}

const CHART_HEIGHT = 560;
const LOAD_MORE_THRESHOLD = 40;

export const PriceChart = forwardRef<PriceChartHandle, PriceChartProps>(function PriceChart(
  { candles, drawingScope, indicators, market, onLoadOlder },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ChartSeries | null>(null);
  const loadOlderRef = useRef(onLoadOlder);
  const candlesRef = useRef(candles);
  const indicatorsRef = useRef(indicators);
  const initialRangeSetRef = useRef(false);
  const previousFirstTimeRef = useRef<number | undefined>(undefined);
  const historyRequestPendingRef = useRef(false);
  const [crosshairCandle, setCrosshairCandle] = useState<ChartCandle>();
  const [drawingSurface, setDrawingSurface] = useState<{
    chart: IChartApi;
    series: ISeriesApi<"Candlestick">;
  }>();
  const indicatorKey = [...indicators].sort().join(",");

  loadOlderRef.current = onLoadOlder;
  candlesRef.current = candles;
  indicatorsRef.current = indicators;

  useImperativeHandle(ref, () => ({
    reset: () => {
      const chart = chartRef.current;
      if (!chart) return;
      showLatestWindow(chart, candlesRef.current.filter(isValidCandle).length);
    },
    toggleFullscreen: () => {
      const panel = containerRef.current?.closest(".chart-panel") as HTMLElement | null;
      if (!panel) return;
      panel.classList.toggle("chart-panel-expanded");
    },
  }), []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      containerRef.current?.closest(".chart-panel")?.classList.remove("chart-panel-expanded");
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cleanupChart = () => undefined;
    const setupFrame = requestAnimationFrame(() => {
      initialRangeSetRef.current = false;
      previousFirstTimeRef.current = undefined;
      historyRequestPendingRef.current = false;

    const chart = createChart(container, {
      height: container.clientHeight || CHART_HEIGHT,
      width: container.clientWidth,
      crosshair: {
        horzLine: { color: "rgba(211, 205, 194, 0.34)", labelBackgroundColor: "#3a3833" },
        mode: CrosshairMode.Normal,
        vertLine: { color: "rgba(211, 205, 194, 0.28)", labelBackgroundColor: "#3a3833" },
      },
      grid: {
        horzLines: { color: "rgba(235, 230, 220, 0.05)" },
        vertLines: { color: "rgba(235, 230, 220, 0.04)" },
      },
      handleScale: {
        axisDoubleClickReset: true,
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      handleScroll: {
        horzTouchDrag: true,
        mouseWheel: true,
        pressedMouseMove: true,
        vertTouchDrag: true,
      },
      layout: {
        attributionLogo: true,
        background: { color: "#0c0c0b", type: ColorType.Solid },
        fontFamily: "var(--font-sans), Inter, sans-serif",
        textColor: "#918c83",
      },
      localization: {
        priceFormatter: (price: number) => formatNumber(price, price < 10 ? 5 : 2),
      },
      rightPriceScale: {
        borderColor: "rgba(235, 230, 220, 0.08)",
        minimumWidth: 76,
        scaleMargins: { bottom: 0.08, top: 0.08 },
      },
      timeScale: {
        barSpacing: 8,
        borderColor: "rgba(235, 230, 220, 0.08)",
        minBarSpacing: 1.5,
        rightOffset: 8,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
        timeVisible: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      borderDownColor: "#f15367",
      borderUpColor: "#28d58f",
      downColor: "#f15367",
      priceLineColor: "#f15367",
      priceLineStyle: 2,
      upColor: "#28d58f",
      wickDownColor: "#f15367",
      wickUpColor: "#28d58f",
    }, 0);
    const series: ChartSeries = { candles: candleSeries };

    const handleCrosshair = (param: MouseEventParams<Time>) => {
      const value = param.seriesData.get(candleSeries) as CandlestickData<Time> | undefined;
      if (!value || value.open === undefined) {
        setCrosshairCandle(undefined);
        return;
      }
      setCrosshairCandle({
        close: value.close,
        high: value.high,
        low: value.low,
        open: value.open,
        time: timeToIso(value.time),
        volume: 0,
      });
    };
    const handleVisibleRange = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!range || historyRequestPendingRef.current) return;
      const info = candleSeries.barsInLogicalRange(range);
      if (!info || info.barsBefore >= LOAD_MORE_THRESHOLD) return;
      historyRequestPendingRef.current = true;
      void loadOlderRef.current().finally(() => {
        historyRequestPendingRef.current = false;
      });
    };
    chart.subscribeCrosshairMove(handleCrosshair);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);
    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry || !container.isConnected) return;
      const width = Math.max(Math.floor(entry.contentRect.width), 1);
      const height = Math.max(Math.floor(entry.contentRect.height), 240);
      chart.resize(width, height);
    });
    resizeObserver.observe(container);
    chartRef.current = chart;
    seriesRef.current = series;
    const initialCandles = candlesRef.current.filter(isValidCandle);
    series.candles.setData(initialCandles.map(toCandlestickData));
    syncVolumeSeries(chart, series, initialCandles);
    configureIndicators(chart, series, indicatorsRef.current, initialCandles);
    if (initialCandles.length > 0) {
      showLatestWindow(chart, initialCandles.length);
      initialRangeSetRef.current = true;
      previousFirstTimeRef.current = Date.parse(initialCandles[0].time);
    }
    setDrawingSurface({ chart, series: candleSeries });

      cleanupChart = () => {
        resizeObserver.disconnect();
        chart.unsubscribeCrosshairMove(handleCrosshair);
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
        chart.remove();
        chartRef.current = null;
        seriesRef.current = null;
      };
    });

    return () => {
      cancelAnimationFrame(setupFrame);
      cleanupChart();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    configureIndicators(chart, series, indicatorsRef.current, candlesRef.current.filter(isValidCandle));
  }, [indicatorKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const cleanCandles = candles.filter(isValidCandle);
    const firstTime = cleanCandles[0] ? Date.parse(cleanCandles[0].time) : undefined;
    const previousVisibleRange = chart.timeScale().getVisibleRange();
    const logicalRange = chart.timeScale().getVisibleLogicalRange();
    const rangeInfo = logicalRange ? series.candles.barsInLogicalRange(logicalRange) : null;
    const wasFollowingLatest = !rangeInfo || rangeInfo.barsAfter < 3;
    const prependedHistory = firstTime !== undefined && previousFirstTimeRef.current !== undefined && firstTime < previousFirstTimeRef.current;

    series.candles.setData(cleanCandles.map(toCandlestickData));
    syncVolumeSeries(chart, series, cleanCandles);
    setIndicatorData(series, cleanCandles);

    if (!initialRangeSetRef.current && cleanCandles.length > 0) {
      showLatestWindow(chart, cleanCandles.length);
      initialRangeSetRef.current = true;
    } else if (prependedHistory && wasFollowingLatest) {
      showLatestWindow(chart, cleanCandles.length);
    } else if (prependedHistory && previousVisibleRange) {
      chart.timeScale().setVisibleRange(previousVisibleRange);
    } else if (wasFollowingLatest) {
      chart.timeScale().scrollToRealTime();
    }
    previousFirstTimeRef.current = firstTime;
  }, [candles]);

  const legendCandle = crosshairCandle ?? candles.at(-1);
  const latestCandle = candles.at(-1);
  const drawingDataRevision = `${candles.length}:${latestCandle?.time ?? ""}:${latestCandle?.high ?? ""}:${latestCandle?.low ?? ""}`;

  return (
    <div className="chart-canvas professional-chart">
      <div className="professional-chart-surface" ref={containerRef} />
      {legendCandle ? (
        <div className="professional-chart-legend" aria-live="polite">
          <strong>{market.pair}</strong>
          <span>O <b>{chartPrice(legendCandle.open)}</b></span>
          <span>H <b>{chartPrice(legendCandle.high)}</b></span>
          <span>L <b>{chartPrice(legendCandle.low)}</b></span>
          <span>C <b>{chartPrice(legendCandle.close)}</b></span>
        </div>
      ) : null}
      {drawingSurface ? (
        <ChartTools
          chart={drawingSurface.chart}
          dataRevision={`${drawingDataRevision}:${indicatorKey}`}
          scope={drawingScope}
          series={drawingSurface.series}
        />
      ) : null}
    </div>
  );
});

function syncVolumeSeries(
  chart: IChartApi,
  series: ChartSeries,
  candles: ChartCandle[],
): void {
  const volumeData = chartVolumeData(candles);
  if (volumeData.length === 0) {
    if (series.volume) {
      chart.removeSeries(series.volume);
      series.volume = undefined;
    }
    series.candles.priceScale().applyOptions({
      scaleMargins: { bottom: 0.08, top: 0.08 },
    });
    return;
  }

  if (!series.volume) {
    series.volume = chart.addSeries(HistogramSeries, {
      base: 0,
      color: "rgba(40, 213, 143, 0.48)",
      lastValueVisible: false,
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      priceScaleId: "volume",
      title: "Volume",
    }, 0);
    series.volume.priceScale().applyOptions({
      borderVisible: false,
      scaleMargins: { bottom: 0.02, top: 0.78 },
      visible: false,
    });
  }

  series.candles.priceScale().applyOptions({
    scaleMargins: { bottom: 0.25, top: 0.08 },
  });
  series.volume.setData(volumeData.map((point): HistogramData<Time> => ({
    color: point.color,
    time: toTime(point.time),
    value: point.value,
  })));
}

function configureIndicators(
  chart: IChartApi,
  series: ChartSeries,
  indicators: ChartIndicatorId[],
  candles: ChartCandle[],
): void {
  removeOptionalSeries(chart, series);
  if (indicators.includes("sma")) {
    series.sma = chart.addSeries(LineSeries, lineOptions("#a985ff", "SMA 20"), 0);
  }
  if (indicators.includes("ema")) {
    series.ema = chart.addSeries(LineSeries, lineOptions("#ffad5c", "EMA 20"), 0);
  }
  if (indicators.includes("bollinger")) {
    series.bollingerUpper = chart.addSeries(LineSeries, lineOptions("rgba(115, 157, 255, 0.82)", "BB upper", 1), 0);
    series.bollingerMiddle = chart.addSeries(LineSeries, lineOptions("rgba(115, 157, 255, 0.44)", "BB middle", 1), 0);
    series.bollingerLower = chart.addSeries(LineSeries, lineOptions("rgba(115, 157, 255, 0.82)", "BB lower", 1), 0);
  }
  if (indicators.includes("vwap")) {
    series.vwap = chart.addSeries(LineSeries, lineOptions("#4dc5ee", "VWAP"), 0);
  }

  let indicatorPane = 2;
  if (indicators.includes("rsi")) {
    series.rsi = chart.addSeries(LineSeries, lineOptions("#c993ff", "RSI 14", 2), indicatorPane);
    series.rsi.createPriceLine({ axisLabelVisible: true, color: "rgba(241, 83, 103, 0.35)", lineWidth: 1, price: 70, title: "70" });
    series.rsi.createPriceLine({ axisLabelVisible: true, color: "rgba(40, 213, 143, 0.35)", lineWidth: 1, price: 30, title: "30" });
    indicatorPane += 1;
  }
  if (indicators.includes("macd")) {
    series.macd = chart.addSeries(LineSeries, lineOptions("#65a7ff", "MACD", 2), indicatorPane);
    series.macdSignal = chart.addSeries(LineSeries, lineOptions("#ffad5c", "Signal", 2), indicatorPane);
    series.macdHistogram = chart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      title: "Histogram",
    }, indicatorPane);
  }
  setIndicatorData(series, candles);
}

function removeOptionalSeries(chart: IChartApi, series: ChartSeries): void {
  if (series.sma) chart.removeSeries(series.sma);
  if (series.ema) chart.removeSeries(series.ema);
  if (series.bollingerUpper) chart.removeSeries(series.bollingerUpper);
  if (series.bollingerMiddle) chart.removeSeries(series.bollingerMiddle);
  if (series.bollingerLower) chart.removeSeries(series.bollingerLower);
  if (series.vwap) chart.removeSeries(series.vwap);
  if (series.rsi) chart.removeSeries(series.rsi);
  if (series.macd) chart.removeSeries(series.macd);
  if (series.macdSignal) chart.removeSeries(series.macdSignal);
  if (series.macdHistogram) chart.removeSeries(series.macdHistogram);
  series.sma = undefined;
  series.ema = undefined;
  series.bollingerUpper = undefined;
  series.bollingerMiddle = undefined;
  series.bollingerLower = undefined;
  series.vwap = undefined;
  series.rsi = undefined;
  series.macd = undefined;
  series.macdSignal = undefined;
  series.macdHistogram = undefined;
}

function setIndicatorData(series: ChartSeries, candles: ChartCandle[]): void {
  series.sma?.setData(toLineData(sma(candles)));
  series.ema?.setData(toLineData(ema(candles)));
  if (series.bollingerUpper || series.bollingerMiddle || series.bollingerLower) {
    const bands = bollingerBands(candles);
    series.bollingerUpper?.setData(toLineData(bands.upper));
    series.bollingerMiddle?.setData(toLineData(bands.middle));
    series.bollingerLower?.setData(toLineData(bands.lower));
  }
  series.vwap?.setData(toLineData(vwap(candles)));
  series.rsi?.setData(toLineData(rsi(candles)));
  if (series.macd || series.macdSignal || series.macdHistogram) {
    const result = macd(candles);
    series.macd?.setData(toLineData(result.macd));
    series.macdSignal?.setData(toLineData(result.signal));
    series.macdHistogram?.setData(result.histogram.map((point): HistogramData<Time> => ({
      color: point.value >= 0 ? "rgba(40, 213, 143, 0.62)" : "rgba(241, 83, 103, 0.62)",
      time: toTime(point.time),
      value: point.value,
    })));
  }
}

function lineOptions(color: string, title: string, lineWidth: 1 | 2 = 2) {
  return {
    color,
    crosshairMarkerVisible: false,
    lastValueVisible: false,
    lineWidth,
    priceLineVisible: false,
    title,
  } as const;
}

function toCandlestickData(candle: ChartCandle): CandlestickData<Time> {
  return {
    close: candle.close,
    high: candle.high,
    low: candle.low,
    open: candle.open,
    time: toTime(candle.time),
  };
}

function toLineData(points: IndicatorPoint[]): LineData<Time>[] {
  return points.map((point) => ({ time: toTime(point.time), value: point.value }));
}

function toTime(value: string): UTCTimestamp {
  return Math.floor(Date.parse(value) / 1_000) as UTCTimestamp;
}

function timeToIso(value: Time): string {
  if (typeof value === "number") return new Date(value * 1_000).toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(Date.UTC(value.year, value.month - 1, value.day)).toISOString();
}

function isValidCandle(candle: ChartCandle): boolean {
  return Number.isFinite(Date.parse(candle.time)) && [
    candle.close,
    candle.high,
    candle.low,
    candle.open,
    candle.volume,
  ].every(Number.isFinite);
}

function chartPrice(value: number): string {
  return formatNumber(value, value < 10 ? 5 : 2);
}

function showLatestWindow(chart: IChartApi, candleCount: number): void {
  const range = latestLogicalRange(candleCount);
  if (range) chart.timeScale().setVisibleLogicalRange(range);
}
