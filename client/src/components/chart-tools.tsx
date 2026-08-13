"use client";

import {
  Lock,
  LockOpen,
  Minus,
  MousePointer2,
  Palette,
  Ruler,
  Trash2,
  TrendingUp,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type {
  IChartApi,
  ISeriesApi,
  Logical,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import {
  CHART_DRAWING_COLORS,
  CHART_DRAWING_LINE_STYLES,
  CHART_DRAWING_THICKNESSES,
  createChartDrawing,
  defaultDrawingAppearance,
  formatMeasurement,
  measureDrawing,
  parseChartDrawings,
  removeChartDrawing,
  serializeChartDrawings,
  setChartDrawingLocked,
  updateChartDrawingAppearance,
  type ChartDrawing,
  type ChartDrawingAppearance,
  type ChartDrawingColor,
  type ChartDrawingLineStyle,
  type ChartDrawingPoint,
  type ChartDrawingThickness,
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

const DRAWING_COLORS: Record<ChartDrawingColor, string> = {
  blue: "rgba(105, 179, 255, 0.9)",
  green: "rgba(40, 213, 143, 0.9)",
  neutral: "rgba(198, 189, 178, 0.82)",
  orange: "rgba(255, 184, 112, 0.9)",
  red: "rgba(241, 83, 103, 0.9)",
};

const DRAWING_WIDTHS: Record<ChartDrawingThickness, number> = {
  medium: 2,
  thick: 3,
  thin: 1.35,
};

const DRAWING_DASHES: Record<ChartDrawingLineStyle, string | undefined> = {
  dashed: "5 4",
  dotted: "1 4",
  solid: undefined,
};

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
  const storageKey = storageKeyFor(scope);
  const [activeTool, setActiveTool] = useState<ChartDrawingTool>("pointer");
  const [cursorPoint, setCursorPoint] = useState<ChartDrawingPoint>();
  const [draftPoint, setDraftPoint] = useState<ChartDrawingPoint>();
  const [drawings, setDrawings] = useState<ChartDrawing[]>(() => (
    typeof window === "undefined"
      ? []
      : parseChartDrawings(window.localStorage.getItem(storageKey))
  ));
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [renderRevision, setRenderRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();

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
    const paneElement = chart.panes()[0]?.getHTMLElement();
    const paneResizeObserver = paneElement ? new ResizeObserver(redraw) : null;
    if (paneElement) paneResizeObserver?.observe(paneElement);
    chartRoot?.addEventListener("wheel", redraw, { capture: true, passive: true });
    chartRoot?.addEventListener("pointermove", redraw, { capture: true, passive: true });
    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(redraw);
      timeScale.unsubscribeSizeChange(redraw);
      paneResizeObserver?.disconnect();
      chartRoot?.removeEventListener("wheel", redraw, true);
      chartRoot?.removeEventListener("pointermove", redraw, true);
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    };
  }, [chart, redraw]);

  useEffect(() => {
    redraw();
    const settledFrame = window.requestAnimationFrame(redraw);
    return () => window.cancelAnimationFrame(settledFrame);
  }, [dataRevision, redraw]);

  const paneSize = chart.paneSize(0);
  const paneWidth = paneSize.width;
  const paneHeight = paneSize.height;
  void renderRevision;
  const selectedDrawing = drawings.find((drawing) => drawing.id === selectedId);
  const visibleDrawings = drawings.map((drawing) => ({
    drawing,
    points: drawing.kind === "horizontal"
      ? [toScreenPricePoint(series, drawing.points[0])]
      : drawing.points.map((point) => toScreenPoint(chart, series, point)),
  }));
  const previewEnd = cursorPoint ? toScreenPoint(chart, series, cursorPoint) : null;
  const previewStart = draftPoint ? toScreenPoint(chart, series, draftPoint) : null;
  const drawingRootStyle = {
    "--chart-drawing-center-y": paneHeight > 0 ? `${paneHeight / 2}px` : "50%",
  } as CSSProperties;
  const drawingHelpId = `chart-drawing-help-${scope.replace(/[^a-z0-9_-]/gi, "-")}`;
  const drawingAppearanceId = `chart-drawing-appearance-${scope.replace(/[^a-z0-9_-]/gi, "-")}`;

  const chooseTool = (tool: ChartDrawingTool) => {
    setActiveTool(tool);
    setDraftPoint(undefined);
    setCursorPoint(undefined);
    setSelectedId(undefined);
    setAppearanceOpen(false);
  };

  const clearInteraction = () => {
    setActiveTool("pointer");
    setDraftPoint(undefined);
    setCursorPoint(undefined);
    setSelectedId(undefined);
    setAppearanceOpen(false);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const ownsEscape = activeTool !== "pointer"
      || Boolean(draftPoint)
      || Boolean(selectedDrawing)
      || appearanceOpen;
    if (event.key === "Escape" && ownsEscape) {
      event.preventDefault();
      event.stopPropagation();
      clearInteraction();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && selectedDrawing) {
      event.preventDefault();
      event.stopPropagation();
      if (selectedDrawing.locked) return;
      setDrawings((current) => removeChartDrawing(current, selectedDrawing.id));
      setSelectedId(undefined);
      setAppearanceOpen(false);
    }
  };

  const updateSelectedAppearance = (patch: Partial<ChartDrawingAppearance>) => {
    if (!selectedDrawing) return;
    setDrawings((current) => updateChartDrawingAppearance(current, selectedDrawing.id, patch));
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeTool === "pointer") return;
    setCursorPoint(pointFromEvent(event, chart, series, paneWidth, paneHeight));
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (activeTool === "pointer" || event.button !== 0) return;
    const point = activeTool === "horizontal"
      ? horizontalPointFromEvent(event, series, paneWidth, paneHeight)
      : pointFromEvent(event, chart, series, paneWidth, paneHeight);
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
      rootRef.current?.focus({ preventScroll: true });
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
      style={drawingRootStyle}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setSelectedId(undefined);
          setAppearanceOpen(false);
        }
      }}
    >
      <span className="sr-only" id={drawingHelpId}>
        Drawing placement requires pointer input. Select a drawing to change its appearance, lock it, or delete it.
      </span>
      <div
        aria-describedby={drawingHelpId}
        aria-label="Chart drawing tools"
        className="chart-drawing-toolbar"
        role="group"
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
              <Icon aria-hidden="true" size={15} />
            </button>
          );
        })}
      </div>

      {selectedDrawing ? (
        <div className="chart-drawing-context">
          <div aria-label="Selected drawing actions" className="chart-drawing-context-actions" role="group">
            <button
              aria-controls={drawingAppearanceId}
              aria-expanded={appearanceOpen}
              aria-label="Drawing appearance"
              disabled={selectedDrawing.locked}
              title={selectedDrawing.locked ? "Unlock to edit appearance" : "Drawing appearance"}
              type="button"
              onClick={() => setAppearanceOpen((current) => !current)}
            >
              <Palette aria-hidden="true" size={14} />
            </button>
            <button
              aria-label={selectedDrawing.locked ? "Unlock drawing" : "Lock drawing"}
              aria-pressed={selectedDrawing.locked}
              title={selectedDrawing.locked ? "Unlock drawing" : "Lock drawing"}
              type="button"
              onClick={() => {
                setDrawings((current) => setChartDrawingLocked(
                  current,
                  selectedDrawing.id,
                  !selectedDrawing.locked,
                ));
                if (!selectedDrawing.locked) setAppearanceOpen(false);
              }}
            >
              {selectedDrawing.locked
                ? <Lock aria-hidden="true" size={14} />
                : <LockOpen aria-hidden="true" size={14} />}
            </button>
            <button
              aria-label="Delete drawing"
              disabled={selectedDrawing.locked}
              title={selectedDrawing.locked ? "Unlock to delete" : "Delete drawing"}
              type="button"
              onClick={() => {
                setDrawings((current) => removeChartDrawing(current, selectedDrawing.id));
                setSelectedId(undefined);
                setAppearanceOpen(false);
              }}
            >
              <Trash2 aria-hidden="true" size={14} />
            </button>
          </div>
          {appearanceOpen && !selectedDrawing.locked ? (
            <div aria-label="Drawing appearance" className="chart-drawing-appearance" id={drawingAppearanceId}>
              <AppearanceRow label="Color">
                {CHART_DRAWING_COLORS.map((color) => (
                  <button
                    aria-label={`${capitalize(color)} line`}
                    aria-pressed={selectedDrawing.appearance.color === color}
                    className="chart-drawing-color-choice"
                    key={color}
                    style={{ "--chart-drawing-swatch": DRAWING_COLORS[color] } as CSSProperties}
                    title={capitalize(color)}
                    type="button"
                    onClick={() => updateSelectedAppearance({ color })}
                  >
                    <span aria-hidden="true" />
                  </button>
                ))}
              </AppearanceRow>
              <AppearanceRow label="Thickness">
                {CHART_DRAWING_THICKNESSES.map((thickness) => (
                  <button
                    aria-label={`${capitalize(thickness)} line thickness`}
                    aria-pressed={selectedDrawing.appearance.thickness === thickness}
                    className="chart-drawing-line-choice"
                    key={thickness}
                    title={capitalize(thickness)}
                    type="button"
                    onClick={() => updateSelectedAppearance({ thickness })}
                  >
                    <span
                      aria-hidden="true"
                      style={{ borderTopWidth: DRAWING_WIDTHS[thickness] }}
                    />
                  </button>
                ))}
              </AppearanceRow>
              <AppearanceRow label="Style">
                {CHART_DRAWING_LINE_STYLES.map((lineStyle) => (
                  <button
                    aria-label={`${capitalize(lineStyle)} line style`}
                    aria-pressed={selectedDrawing.appearance.lineStyle === lineStyle}
                    className="chart-drawing-line-choice"
                    key={lineStyle}
                    title={capitalize(lineStyle)}
                    type="button"
                    onClick={() => updateSelectedAppearance({ lineStyle })}
                  >
                    <svg aria-hidden="true" height="8" viewBox="0 0 28 8" width="28">
                      <line
                        strokeDasharray={DRAWING_DASHES[lineStyle]}
                        x1="1"
                        x2="27"
                        y1="4"
                        y2="4"
                      />
                    </svg>
                  </button>
                ))}
              </AppearanceRow>
            </div>
          ) : null}
        </div>
      ) : null}

      {instruction ? <span className="chart-drawing-instruction">{instruction}</span> : null}

      <svg
        aria-hidden="true"
        className={`chart-drawing-overlay ${activeTool !== "pointer" ? "chart-drawing-overlay-active" : ""}`}
        height={Math.max(paneHeight, 1)}
        style={{
          bottom: "auto",
          height: `${Math.max(paneHeight, 1)}px`,
          right: "auto",
          width: `${Math.max(paneWidth, 1)}px`,
        }}
        viewBox={`0 0 ${Math.max(paneWidth, 1)} ${Math.max(paneHeight, 1)}`}
        width={Math.max(paneWidth, 1)}
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
              setAppearanceOpen(false);
              setSelectedId(drawing.id);
              rootRef.current?.focus({ preventScroll: true });
            }}
          />
        ))}
        {draftPoint && cursorPoint && previewStart && previewEnd ? (
          <DrawingLine
            appearance={defaultDrawingAppearance(activeTool === "measure" ? "measure" : "trend")}
            className="chart-drawing-preview"
            end={previewEnd}
            kind={activeTool === "measure" ? "measure" : "trend"}
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
    <g className={[
      selected ? "chart-drawing-selected" : "",
      drawing.locked ? "chart-drawing-locked" : "",
    ].filter(Boolean).join(" ") || undefined}>
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
        appearance={drawing.appearance}
        end={end}
        kind={drawing.kind}
        start={start}
      />
      {drawing.kind === "horizontal" ? (
        <text
          className="chart-drawing-price-label"
          style={{ fill: DRAWING_COLORS[drawing.appearance.color] }}
          x={Math.max(8, paneWidth - 8)}
          y={clamp(first.y - 6, 13, paneHeight - 7)}
        >
          {formatNumber(drawing.points[0].price, drawing.points[0].price < 10 ? 5 : 2)}
        </text>
      ) : null}
      {measurement ? (
        <g className="chart-measure-label" transform={`translate(${labelX}, ${labelY})`}>
          <rect
            height="23"
            rx="5"
            stroke={DRAWING_COLORS[drawing.appearance.color]}
            strokeOpacity="0.3"
            width="116"
            x="-58"
            y="-12"
          />
          <text
            dominantBaseline="middle"
            fill={DRAWING_COLORS[drawing.appearance.color]}
            textAnchor="middle"
          >
            {measurement}
          </text>
        </g>
      ) : null}
    </g>
  );
}

function DrawingLine({
  appearance,
  className,
  end,
  kind,
  start,
}: {
  appearance: ChartDrawingAppearance;
  className?: string;
  end: ScreenPoint;
  kind: "trend" | "horizontal" | "measure";
  start: ScreenPoint;
}) {
  return (
    <line
      className={["chart-drawing-line", `chart-drawing-${kind}`, className].filter(Boolean).join(" ")}
      x1={start.x}
      x2={end.x}
      y1={start.y}
      y2={end.y}
      stroke={DRAWING_COLORS[appearance.color]}
      strokeDasharray={DRAWING_DASHES[appearance.lineStyle]}
      strokeWidth={DRAWING_WIDTHS[appearance.thickness]}
    />
  );
}

function AppearanceRow({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div aria-label={label} className="chart-drawing-appearance-row" role="group">
      <span>{label}</span>
      <div>{children}</div>
    </div>
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

function horizontalPointFromEvent(
  event: ReactPointerEvent<SVGSVGElement>,
  series: ISeriesApi<"Candlestick">,
  paneWidth: number,
  paneHeight: number,
): ChartDrawingPoint | undefined {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  if (x < 0 || x > paneWidth || y < 0 || y > paneHeight) return undefined;
  const price = series.coordinateToPrice(y);
  if (price === null || !Number.isFinite(price)) return undefined;
  return { price, time: Math.floor(Date.now() / 1_000) };
}

function toScreenPoint(
  chart: IChartApi,
  series: ISeriesApi<"Candlestick">,
  point: ChartDrawingPoint,
): ScreenPoint | null {
  const timeScale = chart.timeScale();
  let x = timeScale.timeToCoordinate(point.time as UTCTimestamp);
  if (x === null) {
    const nearestIndex = timeScale.timeToIndex(point.time as UTCTimestamp, true);
    x = nearestIndex === null
      ? null
      : timeScale.logicalToCoordinate(Number(nearestIndex) as Logical);
  }
  const y = series.priceToCoordinate(point.price);
  if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function toScreenPricePoint(
  series: ISeriesApi<"Candlestick">,
  point: ChartDrawingPoint,
): ScreenPoint | null {
  const y = series.priceToCoordinate(point.price);
  if (y === null || !Number.isFinite(y)) return null;
  return { x: 0, y };
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

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
