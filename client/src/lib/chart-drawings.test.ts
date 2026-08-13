import { describe, expect, test } from "bun:test";
import {
  createChartDrawing,
  formatMeasurement,
  measureDrawing,
  parseChartDrawings,
  removeChartDrawing,
  serializeChartDrawings,
  setChartDrawingLocked,
  updateChartDrawingAppearance,
  type ChartDrawing,
} from "@/lib/chart-drawings";

const first = { price: 2, time: 1_723_456_800 };
const second = { price: 2.1, time: 1_723_460_400 };

describe("chart drawings", () => {
  test("creates horizontal and two-point drawings with valid anchors", () => {
    expect(createChartDrawing("h", "horizontal", first)).toEqual({
      appearance: { color: "neutral", thickness: "thin", lineStyle: "dashed" },
      id: "h",
      kind: "horizontal",
      locked: false,
      points: [first],
    });
    expect(createChartDrawing("t", "trend", first, second)).toEqual({
      appearance: { color: "orange", thickness: "thin", lineStyle: "solid" },
      id: "t",
      kind: "trend",
      locked: false,
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

  test("round trips appearance and lock state while rejecting malformed entries", () => {
    const drawing: ChartDrawing = {
      appearance: { color: "green", thickness: "thick", lineStyle: "dotted" },
      id: "trend-1",
      kind: "trend",
      locked: true,
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

  test("rejects incomplete or invalid persisted drawing state", () => {
    expect(parseChartDrawings(JSON.stringify([
      {
        id: "missing-state",
        kind: "measure",
        points: [first, second],
      },
      {
        appearance: { color: "purple", lineStyle: "wavy", thickness: 12 },
        id: "invalid-appearance",
        kind: "horizontal",
        locked: false,
        points: [first],
      },
      {
        appearance: { color: "neutral", lineStyle: "dashed", thickness: "thin" },
        id: "invalid-lock",
        kind: "horizontal",
        locked: "yes",
        points: [first],
      },
    ]))).toEqual([]);
  });

  test("edits only unlocked drawings and preserves locked drawings during deletion", () => {
    const firstDrawing = createChartDrawing("trend-1", "trend", first, second)!;
    const styled = updateChartDrawingAppearance([firstDrawing], "trend-1", {
      color: "red",
      lineStyle: "dotted",
      thickness: "medium",
    });
    expect(styled[0].appearance).toEqual({
      color: "red",
      lineStyle: "dotted",
      thickness: "medium",
    });

    const locked = setChartDrawingLocked(styled, "trend-1", true);
    expect(updateChartDrawingAppearance(locked, "trend-1", { color: "blue" })).toEqual(locked);
    expect(removeChartDrawing(locked, "trend-1")).toEqual(locked);
  });
});
