export type ChartDrawingTool = "pointer" | "trend" | "horizontal" | "measure";

export type ChartDrawingKind = Exclude<ChartDrawingTool, "pointer">;

export interface ChartDrawingPoint {
  price: number;
  time: number;
}

export interface ChartDrawing {
  id: string;
  kind: ChartDrawingKind;
  points: ChartDrawingPoint[];
}

export interface ChartMeasurement {
  durationMs: number;
  percentChange: number;
  priceChange: number;
}

const MAX_PERSISTED_DRAWINGS = 100;

export function createChartDrawing(
  id: string,
  kind: ChartDrawingKind,
  first: ChartDrawingPoint,
  second?: ChartDrawingPoint,
): ChartDrawing | null {
  if (!isDrawingPoint(first)) return null;
  if (kind === "horizontal") {
    return { id, kind, points: [first] };
  }
  if (!second || !isDrawingPoint(second)) return null;
  return { id, kind, points: [first, second] };
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
      .filter(isChartDrawing)
      .slice(-MAX_PERSISTED_DRAWINGS);
  } catch {
    return [];
  }
}

export function serializeChartDrawings(drawings: ChartDrawing[]): string {
  return JSON.stringify(drawings.filter(isChartDrawing).slice(-MAX_PERSISTED_DRAWINGS));
}

function isChartDrawing(value: unknown): value is ChartDrawing {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChartDrawing>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
  if (candidate.kind !== "trend" && candidate.kind !== "horizontal" && candidate.kind !== "measure") {
    return false;
  }
  if (!Array.isArray(candidate.points)) return false;
  const expectedPoints = candidate.kind === "horizontal" ? 1 : 2;
  return candidate.points.length === expectedPoints && candidate.points.every(isDrawingPoint);
}

function isDrawingPoint(value: unknown): value is ChartDrawingPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<ChartDrawingPoint>;
  return Number.isFinite(point.price) && Number.isFinite(point.time) && Number(point.time) > 0;
}

function formatDuration(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
