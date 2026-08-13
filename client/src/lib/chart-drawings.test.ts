import { describe, expect, test } from "bun:test";
import {
  createChartDrawing,
  formatMeasurement,
  measureDrawing,
  parseChartDrawings,
  serializeChartDrawings,
  type ChartDrawing,
} from "@/lib/chart-drawings";

const first = { price: 2, time: 1_723_456_800 };
const second = { price: 2.1, time: 1_723_460_400 };

describe("chart drawings", () => {
  test("creates horizontal and two-point drawings with valid anchors", () => {
    expect(createChartDrawing("h", "horizontal", first)).toEqual({
      id: "h",
      kind: "horizontal",
      points: [first],
    });
    expect(createChartDrawing("t", "trend", first, second)).toEqual({
      id: "t",
      kind: "trend",
      points: [first, second],
    });
    expect(createChartDrawing("m", "measure", first)).toBeNull();
  });

  test("calculates price change, percentage and elapsed time", () => {
    const measurement = measureDrawing(first, second);
    expect(measurement.priceChange).toBeCloseTo(0.1);
    expect(measurement.percentChange).toBeCloseTo(5);
    expect(measurement.durationMs).toBe(3_600_000);
    expect(formatMeasurement(measurement)).toBe("+5.00% · 1h");
  });

  test("round trips valid persisted drawings and rejects malformed entries", () => {
    const drawing: ChartDrawing = {
      id: "trend-1",
      kind: "trend",
      points: [first, second],
    };
    expect(parseChartDrawings(serializeChartDrawings([drawing]))).toEqual([drawing]);
    expect(parseChartDrawings("not-json")).toEqual([]);
    expect(parseChartDrawings(JSON.stringify([
      drawing,
      { id: "bad", kind: "trend", points: [first] },
      { id: "bad-kind", kind: "box", points: [first, second] },
    ]))).toEqual([drawing]);
  });
});
