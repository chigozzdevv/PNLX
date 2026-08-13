"use client";

import {
  Crosshair,
  Minus,
  MousePointer2,
  Ruler,
  Trash2,
  TrendingUp,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  IChartApi,
  ISeriesApi,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import {
  createChartDrawing,
  formatMeasurement,
  measureDrawing,
  parseChartDrawings,
  serializeChartDrawings,
  type ChartDrawing,
  type ChartDrawingPoint,
  type ChartDrawingTool,
} from "@/lib/chart-drawings";
import { formatNumber } from "@/lib/format";

interface ChartToolsProps {
  chart: IChartApi;
  dataRevision: string;
  scope: string;
  series: ISeriesApi<"Candlestick">;
}

interface ScreenPoint {
  x: number;
  y: number;
}

const STORAGE_PREFIX = "pnlx:chart-drawings:v1";

const tools: Array<{
  icon: typeof MousePointer2;
  id: ChartDrawingTool;
  label: string;
}> = [
  { icon: MousePointer2, id: "pointer", label: "Navigate chart" },
  { icon: TrendingUp, id: "trend", label: "Draw trend line" },
  { icon: Minus, id: "horizontal", label: "Draw horizontal line" },
  { icon: Ruler, id: "measure", label: "Measure price and time" },
];

export function ChartTools({ chart, dataRevision, scope, series }: ChartToolsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [activeTool, setActiveTool] = useState<ChartDrawingTool>("pointer");
  const [cursorPoint, setCursorPoint] = useState<ChartDrawingPoint>();
  const [draftPoint, setDraftPoint] = useState<ChartDrawingPoint>();
  const [drawings, setDrawings] = useState<ChartDrawing[]>(() => (
    typeof window === "undefined"
      ? []
      : parseChartDrawings(window.localStorage.getItem(storageKeyFor(scope)))
  ));
  const [renderRevision, setRenderRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const storageKey = storageKeyFor(scope);

  const redraw = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      setRenderRevision((current) => current + 1);
    });
  }, []);

  useEffect(() => {
    window.localStorage.setItem(storageKey, serializeChartDrawings(drawings));
  }, [drawings, storageKey]);

  useEffect(() => {
    const timeScale = chart.timeScale();
    timeScale.subscribeVisibleLogicalRangeChange(redraw);
    timeScale.subscribeSizeChange(redraw);
    const chartRoot = rootRef.current?.parentElement;
    chartRoot?.addEventListener("wheel", redraw, { capture: true, passive: true });
    chartRoot?.addEventListener("pointermove", redraw, { capture: true, passive: true });
    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(redraw);
      timeScale.unsubscribeSizeChange(redraw);
      chartRoot?.removeEventListener("wheel", redraw, true);
      chartRoot?.removeEventListener("pointermove", redraw, true);
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    };
  }, [chart, redraw]);

  useEffect(() => {
    redraw();
  }, [dataRevision, redraw]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActiveTool("pointer");
        setDraftPoint(undefined);
        setCursorPoint(undefined);
        setSelectedId(undefined);
      }
      if ((event.key === "Backspace" || event.key === "Delete") && selectedId) {
        event.preventDefault();
        setDrawings((current) => current.filter((drawing) => drawing.id !== selectedId));
        setSelectedId(undefined);
      }
    };
    const root = rootRef.current;
    root?.addEventListener("keydown", handleKeyDown);
    return () => root?.removeEventListener("keydown", handleKeyDown);
  }, [selectedId]);

  const paneWidth = chart.timeScale().width();
  const paneHeight = chart.panes()[0]?.getHeight() ?? 0;
  void renderRevision;
  const visibleDrawings = drawings.map((drawing) => ({
    drawing,
    points: drawing.points.map((point) => toScreenPoint(chart, series, point)),
  }));
  const previewEnd = cursorPoint ? toScreenPoint(chart, series, cursorPoint) : null;
  const previewStart = draftPoint ? toScreenPoint(chart, series, draftPoint) : null;

  const chooseTool = (tool: ChartDrawingTool) => {
    setActiveTool(tool);
    setDraftPoint(undefined);
    setCursorPoint(undefined);
    setSelectedId(undefined);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeTool === "pointer") return;
    setCursorPoint(pointFromEvent(event, chart, series, paneWidth, paneHeight));
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeTool === "pointer" || event.button !== 0) return;
    const point = pointFromEvent(event, chart, series, paneWidth, paneHeight);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();

    if (activeTool === "horizontal") {
      const drawing = createChartDrawing(createDrawingId(), activeTool, point);
      if (drawing) setDrawings((current) => [...current, drawing]);
      chooseTool("pointer");
      return;
    }

    if (!draftPoint) {
      setDraftPoint(point);
      return;
    }
    const drawing = createChartDrawing(createDrawingId(), activeTool, draftPoint, point);
    if (drawing) setDrawings((current) => [...current, drawing]);
    chooseTool("pointer");
  };

  const instruction = activeTool === "horizontal"
    ? "Click the chart to place a price level"
    : draftPoint
      ? "Click the second point · Esc to cancel"
      : activeTool === "pointer"
        ? null
        : "Click the first point · Esc to cancel";

  return (
    <div
      aria-label="Chart drawing canvas"
      className="chart-drawing-root"
      ref={rootRef}
      tabIndex={-1}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSelectedId(undefined);
      }}
    >
      <span className="sr-only" id={`chart-drawing-help-${scope.replace(/[^a-z0-9_-]/gi, "-")}`}>
        Drawing placement requires pointer input. Select a drawing and press Delete to remove it.
      </span>
      <div
        aria-describedby={`chart-drawing-help-${scope.replace(/[^a-z0-9_-]/gi, "-")}`}
        aria-label="Chart drawing tools"
        aria-orientation="vertical"
        className="chart-drawing-toolbar"
        role="toolbar"
      >
        {tools.map((tool) => {
          const Icon = tool.icon;
          return (
            <button
              aria-label={tool.label}
              aria-pressed={activeTool === tool.id}
              className={activeTool === tool.id ? "chart-drawing-tool-active" : ""}
              key={tool.id}
              title={tool.label}
              type="button"
              onClick={() => chooseTool(tool.id)}
            >
              {tool.id === "pointer" ? <Crosshair aria-hidden="true" size={15} /> : <Icon aria-hidden="true" size={15} />}
            </button>
          );
        })}
        <span aria-hidden="true" className="chart-drawing-divider" />
        <button
          aria-label="Clear chart drawings"
          disabled={drawings.length === 0}
          title="Clear drawings"
          type="button"
          onClick={() => {
            setDrawings([]);
            setSelectedId(undefined);
            chooseTool("pointer");
          }}
        >
          <Trash2 aria-hidden="true" size={14} />
        </button>
      </div>

      {instruction ? <span className="chart-drawing-instruction">{instruction}</span> : null}

      <svg
        aria-hidden="true"
        className={`chart-drawing-overlay ${activeTool !== "pointer" ? "chart-drawing-overlay-active" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerLeave={() => setCursorPoint(undefined)}
        onPointerMove={handlePointerMove}
      >
        {visibleDrawings.map(({ drawing, points }) => (
          <RenderedDrawing
            drawing={drawing}
            key={drawing.id}
            paneHeight={paneHeight}
            paneWidth={paneWidth}
            points={points}
            selected={drawing.id === selectedId}
            onSelect={() => {
              setActiveTool("pointer");
              setDraftPoint(undefined);
              setSelectedId(drawing.id);
              rootRef.current?.focus({ preventScroll: true });
            }}
          />
        ))}
        {draftPoint && cursorPoint && previewStart && previewEnd ? (
          <DrawingLine
            className="chart-drawing-preview"
            end={previewEnd}
            kind={activeTool === "measure" ? "measure" : "trend"}
            paneHeight={paneHeight}
            paneWidth={paneWidth}
            start={previewStart}
          />
        ) : null}
      </svg>
    </div>
  );
}

function RenderedDrawing({
  drawing,
  onSelect,
  paneHeight,
  paneWidth,
  points,
  selected,
}: {
  drawing: ChartDrawing;
  onSelect: () => void;
  paneHeight: number;
  paneWidth: number;
  points: Array<ScreenPoint | null>;
  selected: boolean;
}) {
  const first = points[0];
  const second = points[1];
  if (!first || (drawing.kind !== "horizontal" && !second)) return null;
  const start = drawing.kind === "horizontal" ? { x: 0, y: first.y } : first;
  const end = drawing.kind === "horizontal" ? { x: paneWidth, y: first.y } : second!;
  const measurement = drawing.kind === "measure"
    ? formatMeasurement(measureDrawing(drawing.points[0], drawing.points[1]))
    : undefined;
  const labelX = clamp((start.x + end.x) / 2, 64, Math.max(64, paneWidth - 64));
  const labelY = clamp((start.y + end.y) / 2 - 11, 16, Math.max(16, paneHeight - 16));

  return (
    <g className={selected ? "chart-drawing-selected" : undefined}>
      <line
        className="chart-drawing-hit-area"
        x1={start.x}
        x2={end.x}
        y1={start.y}
        y2={end.y}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
        }}
      />
      <DrawingLine
        end={end}
        kind={drawing.kind}
        paneHeight={paneHeight}
        paneWidth={paneWidth}
        start={start}
      />
      {drawing.kind === "horizontal" ? (
        <text className="chart-drawing-price-label" x={Math.max(8, paneWidth - 8)} y={clamp(first.y - 6, 13, paneHeight - 7)}>
          {formatNumber(drawing.points[0].price, drawing.points[0].price < 10 ? 5 : 2)}
        </text>
      ) : null}
      {measurement ? (
        <g className="chart-measure-label" transform={`translate(${labelX}, ${labelY})`}>
          <rect height="23" rx="5" width="116" x="-58" y="-12" />
          <text dominantBaseline="middle" textAnchor="middle">{measurement}</text>
        </g>
      ) : null}
      {selected ? (
        <>
          <circle className="chart-drawing-handle" cx={start.x} cy={start.y} r="3.5" />
          {drawing.kind !== "horizontal" ? <circle className="chart-drawing-handle" cx={end.x} cy={end.y} r="3.5" /> : null}
        </>
      ) : null}
    </g>
  );
}

function DrawingLine({
  className,
  end,
  kind,
  start,
}: {
  className?: string;
  end: ScreenPoint;
  kind: "trend" | "horizontal" | "measure";
  paneHeight: number;
  paneWidth: number;
  start: ScreenPoint;
}) {
  return (
    <line
      className={["chart-drawing-line", `chart-drawing-${kind}`, className].filter(Boolean).join(" ")}
      x1={start.x}
      x2={end.x}
      y1={start.y}
      y2={end.y}
    />
  );
}

function pointFromEvent(
  event: ReactPointerEvent<SVGSVGElement>,
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  paneWidth: number,
  paneHeight: number,
): ChartDrawingPoint | undefined {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  if (x < 0 || x > paneWidth || y < 0 || y > paneHeight) return undefined;
  const time = chart.timeScale().coordinateToTime(x);
  const price = series.coordinateToPrice(y);
  const timestamp = toTimestamp(time);
  if (timestamp === null || price === null || !Number.isFinite(price)) return undefined;
  return { price, time: timestamp };
}

function toScreenPoint(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  point: ChartDrawingPoint,
): ScreenPoint | null {
  const x = chart.timeScale().timeToCoordinate(point.time as UTCTimestamp);
  const y = series.priceToCoordinate(point.price);
  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function toTimestamp(time: Time | null): number | null {
  if (time === null) return null;
  if (typeof time === "number") return time;
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
  }
  return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1_000);
}

function createDrawingId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `drawing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function storageKeyFor(scope: string): string {
  return `${STORAGE_PREFIX}:${scope}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
