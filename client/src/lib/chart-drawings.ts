export type ChartDrawingTool = "pointer" | "trend" | "horizontal" | "measure";

export type ChartDrawingKind = Exclude<ChartDrawingTool, "pointer">;

export const CHART_DRAWING_COLORS = ["orange", "neutral", "blue", "green", "red"] as const;
export const CHART_DRAWING_THICKNESSES = ["thin", "medium", "thick"] as const;
export const CHART_DRAWING_LINE_STYLES = ["solid", "dashed", "dotted"] as const;

export type ChartDrawingColor = (typeof CHART_DRAWING_COLORS)[number];
export type ChartDrawingThickness = (typeof CHART_DRAWING_THICKNESSES)[number];
export type ChartDrawingLineStyle = (typeof CHART_DRAWING_LINE_STYLES)[number];

export interface ChartDrawingAppearance {
  color: ChartDrawingColor;
  thickness: ChartDrawingThickness;
  lineStyle: ChartDrawingLineStyle;
}

export interface ChartDrawingPoint {
  price: number;
  time: number;
}

export interface ChartDrawing {
  appearance: ChartDrawingAppearance;
  id: string;
  kind: ChartDrawingKind;
  locked: boolean;
  points: ChartDrawingPoint[];
}

export interface ChartMeasurement {
  durationMs: number;
  percentChange: number;
  priceChange: number;
}

const MAX_PERSISTED_DRAWINGS = 100;

export function defaultDrawingAppearance(kind: ChartDrawingKind): ChartDrawingAppearance {
  if (kind === "horizontal") {
    return { color: "neutral", thickness: "thin", lineStyle: "dashed" };
  }
  if (kind === "measure") {
    return { color: "blue", thickness: "thin", lineStyle: "dashed" };
  }
  return { color: "orange", thickness: "thin", lineStyle: "solid" };
}

export function createChartDrawing(
  id: string,
  kind: ChartDrawingKind,
  first: ChartDrawingPoint,
  second?: ChartDrawingPoint,
): ChartDrawing | null {
  if (!isDrawingPoint(first)) return null;
  if (kind === "horizontal") {
    return {
      appearance: defaultDrawingAppearance(kind),
      id,
      kind,
      locked: false,
      points: [first],
    };
  }
  if (!second || !isDrawingPoint(second)) return null;
  return {
    appearance: defaultDrawingAppearance(kind),
    id,
    kind,
    locked: false,
    points: [first, second],
  };
}

export function updateChartDrawingAppearance(
  drawings: ChartDrawing[],
  id: string,
  patch: Partial<ChartDrawingAppearance>,
): ChartDrawing[] {
  return drawings.map((drawing) => {
    if (drawing.id !== id || drawing.locked) return drawing;
    const appearance = parseDrawingAppearance({ ...drawing.appearance, ...patch });
    return {
      ...drawing,
      appearance: appearance ?? drawing.appearance,
    };
  });
}

export function setChartDrawingLocked(
  drawings: ChartDrawing[],
  id: string,
  locked: boolean,
): ChartDrawing[] {
  return drawings.map((drawing) => drawing.id === id ? { ...drawing, locked } : drawing);
}

export function removeChartDrawing(drawings: ChartDrawing[], id: string): ChartDrawing[] {
  return drawings.filter((drawing) => drawing.id !== id || drawing.locked);
}

export function measureDrawing(
  first: ChartDrawingPoint,
  second: ChartDrawingPoint,
): ChartMeasurement {
  const priceChange = second.price - first.price;
  return {
    durationMs: Math.abs(second.time - first.time) * 1_000,
    percentChange: first.price === 0 ? 0 : (priceChange / first.price) * 100,
    priceChange,
  };
}

export function formatMeasurement(measurement: ChartMeasurement): string {
  const sign = measurement.percentChange > 0 ? "+" : "";
  return `${sign}${measurement.percentChange.toFixed(2)}% · ${formatDuration(measurement.durationMs)}`;
}

export function parseChartDrawings(value: string | null): ChartDrawing[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeChartDrawing)
      .filter((drawing): drawing is ChartDrawing => drawing !== null)
      .slice(-MAX_PERSISTED_DRAWINGS);
  } catch {
    return [];
  }
}

export function serializeChartDrawings(drawings: ChartDrawing[]): string {
  return JSON.stringify(
    drawings
      .map(normalizeChartDrawing)
      .filter((drawing): drawing is ChartDrawing => drawing !== null)
      .slice(-MAX_PERSISTED_DRAWINGS),
  );
}

function normalizeChartDrawing(value: unknown): ChartDrawing | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ChartDrawing>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (candidate.kind !== "trend" && candidate.kind !== "horizontal" && candidate.kind !== "measure") {
    return null;
  }
  if (!Array.isArray(candidate.points)) return null;
  const expectedPoints = candidate.kind === "horizontal" ? 1 : 2;
  if (candidate.points.length !== expectedPoints || !candidate.points.every(isDrawingPoint)) {
    return null;
  }
  const appearance = parseDrawingAppearance(candidate.appearance);
  if (!appearance || typeof candidate.locked !== "boolean") return null;
  return {
    appearance,
    id: candidate.id,
    kind: candidate.kind,
    locked: candidate.locked,
    points: candidate.points,
  };
}

function parseDrawingAppearance(value: unknown): ChartDrawingAppearance | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ChartDrawingAppearance>;
  if (
    !isOneOf(candidate.color, CHART_DRAWING_COLORS)
    || !isOneOf(candidate.thickness, CHART_DRAWING_THICKNESSES)
    || !isOneOf(candidate.lineStyle, CHART_DRAWING_LINE_STYLES)
  ) {
    return null;
  }
  return {
    color: candidate.color,
    thickness: candidate.thickness,
    lineStyle: candidate.lineStyle,
  };
}

function isDrawingPoint(value: unknown): value is ChartDrawingPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<ChartDrawingPoint>;
  return Number.isFinite(point.price) && Number.isFinite(point.time) && Number(point.time) > 0;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function formatDuration(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
