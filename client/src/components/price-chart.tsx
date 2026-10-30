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
import {
  DEFAULT_BAR_SPACING,
  MAX_BAR_SPACING,
  MIN_BAR_SPACING,
  RIGHT_OFFSET_BARS,
  isFollowingLatest,
  latestLogicalRange,
  preserveLogicalRange,
  zoomLogicalRange,
} from "@/lib/chart-range";
import { formatNumber } from "@/lib/format";
import type { ChartCandle, MarketDisplay } from "@/types/trading";

export interface PriceChartProps {
  candles: ChartCandle[];
  drawingScope: string;
  indicators: ChartIndicatorId[];
  market: MarketDisplay;
  onFullscreenChange?: (fullscreen: boolean) => void;
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

function chartTheme(container: HTMLElement) {
  const light = document.documentElement.dataset.theme === "light";
  const style = getComputedStyle(container);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const line = token("--line", light ? "rgba(28, 27, 24, 0.11)" : "rgba(255, 255, 255, 0.085)");
  const muted = token("--text-muted", light ? "#626774" : "#a0a2ae");
  const faint = token("--text-faint", light ? "#777d89" : "#777b89");
  return {
    crosshair: {
      horzLine: { color: faint, labelBackgroundColor: muted },
      mode: CrosshairMode.Normal,
      vertLine: { color: faint, labelBackgroundColor: muted },
    },
    grid: {
      horzLines: { color: line },
      vertLines: { color: line },
    },
    layout: {
      attributionLogo: true,
      background: { color: token("--surface-page", light ? "#fafafa" : "#101114"), type: ColorType.Solid },
      fontFamily: style.fontFamily,
      fontSize: container.clientWidth < 600 ? 11 : 12,
      textColor: muted,
    },
    rightPriceScale: { borderColor: line },
    timeScale: { borderColor: line },
  };
}

export const PriceChart = forwardRef<PriceChartHandle, PriceChartProps>(function PriceChart(
  { candles, drawingScope, indicators, market, onFullscreenChange, onLoadOlder },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ChartSeries | null>(null);
  const loadOlderRef = useRef(onLoadOlder);
  const candlesRef = useRef(candles);
  const indicatorsRef = useRef(indicators);
  const initialRangeSetRef = useRef(false);
  const renderedCandlesRef = useRef<ChartCandle[]>([]);
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
      seriesRef.current?.candles.priceScale().setAutoScale(true);
      showLatestWindow(chart, candlesRef.current.filter(isValidCandle).length);
    },
    toggleFullscreen: () => {
      const panel = containerRef.current?.closest(".chart-panel") as HTMLElement | null;
      if (!panel) return;
      const expanded = panel.classList.toggle("chart-panel-expanded");
      onFullscreenChange?.(expanded);
    },
  }), [onFullscreenChange]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      containerRef.current?.closest(".chart-panel")?.classList.remove("chart-panel-expanded");
      onFullscreenChange?.(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onFullscreenChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cleanupChart = () => undefined;
    const setupFrame = requestAnimationFrame(() => {
      initialRangeSetRef.current = false;
      renderedCandlesRef.current = [];
      historyRequestPendingRef.current = false;
      const theme = chartTheme(container);

    const chart = createChart(container, {
      height: container.clientHeight || CHART_HEIGHT,
      width: container.clientWidth,
      ...theme,
      handleScale: {
        axisDoubleClickReset: true,
        axisPressedMouseMove: { price: true, time: true },
        mouseWheel: false,
        pinch: true,
      },
      handleScroll: {
        horzTouchDrag: true,
        mouseWheel: false,
        pressedMouseMove: true,
        vertTouchDrag: false,
      },
      localization: {
        priceFormatter: (price: number) => formatNumber(price, price < 10 ? 5 : 2),
      },
      rightPriceScale: {
        ...theme.rightPriceScale,
        minimumWidth: container.clientWidth < 600 ? 64 : 76,
        scaleMargins: { bottom: 0.08, top: 0.08 },
      },
      timeScale: {
        ...theme.timeScale,
        barSpacing: DEFAULT_BAR_SPACING,
        minBarSpacing: MIN_BAR_SPACING,
        maxBarSpacing: MAX_BAR_SPACING,
        rightOffset: RIGHT_OFFSET_BARS,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: false,
        timeVisible: true,
      },
    });
    const refreshTheme = () => chart.applyOptions(chartTheme(container));
    const themeObserver = new MutationObserver(refreshTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const themeScope = container.closest(".app-shell-trade");
    if (themeScope) themeObserver.observe(themeScope, { attributes: true, attributeFilter: ["class", "style"] });
    document.fonts.addEventListener("loadingdone", refreshTheme);

    const interactionRoot = container.parentElement ?? container;
    const handleWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest(".chart-drawing-toolbar, .chart-drawing-context")) return;
      const scale = chart.timeScale();
      const range = scale.getVisibleLogicalRange();
      if (!range) return;
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientWidth : 1;
      const horizontalPan = !event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontalPan) {
        const width = scale.width();
        if (width <= 0) return;
        const x = event.clientX - container.getBoundingClientRect().left;
        scale.setVisibleLogicalRange(zoomLogicalRange(range, Math.exp(event.deltaY * multiplier * 0.002), x / width, width));
      } else {
        // Keep horizontal trackpad gestures for history; vertical scrolling zooms at the pointer.
        scale.scrollToPosition(scale.scrollPosition() + event.deltaX * multiplier / scale.options().barSpacing, false);
      }
    };
    interactionRoot.addEventListener("wheel", handleWheel, { passive: false });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      title: "Last",
      borderDownColor: "#ef5350",
      borderUpColor: "#26a69a",
      downColor: "#ef5350",
      priceLineStyle: 2,
      upColor: "#26a69a",
      wickDownColor: "#ef5350",
      wickUpColor: "#26a69a",
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
      const followingLatest = renderedCandlesRef.current.length > 0 &&
        isFollowingLatest(chart.timeScale().getVisibleLogicalRange(), renderedCandlesRef.current.length);
      chart.applyOptions({
        layout: { fontSize: width < 600 ? 11 : 12 },
        rightPriceScale: { minimumWidth: width < 600 ? 64 : 76 },
      });
      chart.resize(width, height, true);
      if (followingLatest) chart.timeScale().scrollToPosition(RIGHT_OFFSET_BARS, false);
    });
    resizeObserver.observe(container);
    chartRef.current = chart;
    seriesRef.current = series;
    const initialCandles = candlesRef.current.filter(isValidCandle);
    series.candles.setData(initialCandles.map(toCandlestickData));
    renderedCandlesRef.current = initialCandles;
    syncVolumeSeries(chart, series, initialCandles);
    configureIndicators(chart, series, indicatorsRef.current, initialCandles);
    if (initialCandles.length > 0) {
      showLatestWindow(chart, initialCandles.length);
      initialRangeSetRef.current = true;
    }
    setDrawingSurface({ chart, series: candleSeries });

      cleanupChart = () => {
        themeObserver.disconnect();
        document.fonts.removeEventListener("loadingdone", refreshTheme);
        interactionRoot.removeEventListener("wheel", handleWheel);
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
    const previousCandles = renderedCandlesRef.current;
    const logicalRange = chart.timeScale().getVisibleLogicalRange();
    const nextRange = preserveLogicalRange(logicalRange, previousCandles, cleanCandles,
      isFollowingLatest(logicalRange, previousCandles.length));

    const latestOnly = previousCandles.length > 0 && cleanCandles.length >= previousCandles.length &&
      cleanCandles.length <= previousCandles.length + 1 &&
      previousCandles.slice(0, -1).every((candle, index) => sameCandle(candle, cleanCandles[index])) &&
      previousCandles.at(-1)?.time === cleanCandles[previousCandles.length - 1]?.time;
    if (latestOnly) {
      series.candles.update(toCandlestickData(cleanCandles[previousCandles.length - 1]));
      if (cleanCandles.length > previousCandles.length) series.candles.update(toCandlestickData(cleanCandles.at(-1)!));
    } else series.candles.setData(cleanCandles.map(toCandlestickData));
    syncVolumeSeries(chart, series, cleanCandles);
    setIndicatorData(series, cleanCandles);
    renderedCandlesRef.current = cleanCandles;

    if (!initialRangeSetRef.current && cleanCandles.length > 0) {
      showLatestWindow(chart, cleanCandles.length);
      initialRangeSetRef.current = true;
    } else if (nextRange) chart.timeScale().setVisibleLogicalRange(nextRange);
  }, [candles]);

  const legendCandle = crosshairCandle ?? candles.at(-1);
  const latestCandle = candles.at(-1);
  const drawingDataRevision = `${candles.length}:${latestCandle?.time ?? ""}:${latestCandle?.high ?? ""}:${latestCandle?.low ?? ""}`;

  return (
    <div className="chart-canvas professional-chart">
      <div className="professional-chart-surface" ref={containerRef} />
      {legendCandle ? (
        <div className="professional-chart-legend" aria-live="polite" title="Reference candles: Hyperliquid.">
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
  const range = latestLogicalRange(candleCount, chart.timeScale().width());
  if (range) chart.timeScale().setVisibleLogicalRange(range);
}

function sameCandle(a: ChartCandle, b: ChartCandle | undefined): boolean {
  return Boolean(b && a.time === b.time && a.open === b.open && a.high === b.high &&
    a.low === b.low && a.close === b.close && a.volume === b.volume && a.trades === b.trades);
}
