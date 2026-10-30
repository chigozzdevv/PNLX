import { describe, expect, test } from "bun:test";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  OBSERVATION_LEVERAGES,
  OBSERVATION_MARGINS_USDC,
  OBSERVATION_MARKETS,
  createObservationPlan,
  observationCloseDueAt,
} from "./plan";

const input = {
  runId: "observation-2026-10-30",
  seed: "durable-seed-1",
  startAt: "2026-10-30T09:00:00Z",
};

describe("observation campaign plan", () => {
  test("has exactly 140 individually identified cycles across seven fixed 24-hour days", () => {
    const plan = createObservationPlan(input);
    expect(plan.version).toBe(1);
    expect(plan.days).toBe(7);
    expect(plan.cyclesPerDay).toBe(20);
    expect(plan.endsAt - plan.startAt).toBe(7 * DAY_MS);
    expect(plan.cycles).toHaveLength(140);
    expect(new Set(plan.cycles.map((cycle) => cycle.cycleId)).size).toBe(140);
    expect(plan.cycles.map((cycle) => cycle.sequence)).toEqual(Array.from({ length: 140 }, (_, index) => index + 1));

    for (let day = 1; day <= 7; day += 1) {
      const cycles = plan.cycles.filter((cycle) => cycle.day === day);
      expect(cycles).toHaveLength(20);
      expect(cycles.map((cycle) => cycle.daySequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      for (const cycle of cycles) {
        expect(cycle.runId).toBe(input.runId);
        expect(cycle.cycleId).toBe(`${input.runId}:day-${day}:cycle-${cycle.daySequence}`);
        expect(cycle.plannedOpenAt).toBeGreaterThanOrEqual(plan.startAt + (day - 1) * DAY_MS);
        expect(cycle.plannedOpenAt).toBeLessThan(plan.startAt + day * DAY_MS);
      }
    }
  });

  test("each day has the requested hold distribution, markets, sides, margins, and leverages", () => {
    const plan = createObservationPlan(input);
    const holdRanges = {
      short: [5 * MINUTE_MS, 30 * MINUTE_MS],
      medium: [HOUR_MS, 3 * HOUR_MS],
      long: [6 * HOUR_MS, 12 * HOUR_MS],
    } as const;

    for (let day = 1; day <= 7; day += 1) {
      const cycles = plan.cycles.filter((cycle) => cycle.day === day);
      expect(cycles.filter((cycle) => cycle.holdClass === "short")).toHaveLength(12);
      expect(cycles.filter((cycle) => cycle.holdClass === "medium")).toHaveLength(6);
      expect(cycles.filter((cycle) => cycle.holdClass === "long")).toHaveLength(2);
      expect(cycles.filter((cycle) => cycle.side === "long")).toHaveLength(10);
      expect(cycles.filter((cycle) => cycle.side === "short")).toHaveLength(10);
      for (const market of OBSERVATION_MARKETS) {
        expect([6, 7]).toContain(cycles.filter((cycle) => cycle.market === market).length);
        for (const side of ["long", "short"]) {
          expect(cycles.some((cycle) => cycle.market === market && cycle.side === side)).toBe(true);
        }
      }
      for (const margin of OBSERVATION_MARGINS_USDC) {
        expect(cycles.filter((cycle) => cycle.marginUsdc === margin)).toHaveLength(5);
      }
      for (const leverage of OBSERVATION_LEVERAGES) {
        expect(cycles.filter((cycle) => cycle.leverage === leverage)).toHaveLength(4);
      }
      for (const cycle of cycles) {
        const [minimum, maximum] = holdRanges[cycle.holdClass];
        expect(cycle.holdDurationMs).toBeGreaterThanOrEqual(minimum);
        expect(cycle.holdDurationMs).toBeLessThanOrEqual(maximum);
      }
    }
  });

  test("is reproducible after persistence and restart without consulting current time", () => {
    const first = createObservationPlan(input);
    const persisted = JSON.parse(JSON.stringify(first));
    expect(createObservationPlan({ runId: persisted.runId, seed: persisted.seed, startAt: persisted.startAt })).toEqual(first);
    expect(createObservationPlan({ ...input, startAt: new Date(input.startAt) })).toEqual(first);
    expect(createObservationPlan({ ...input, startAt: "2026-10-30T10:00:00+01:00" })).toEqual(first);
    expect(createObservationPlan({ ...input, seed: "different-seed" }).cycles).not.toEqual(first.cycles);
    const anotherRun = createObservationPlan({ ...input, runId: "separate-campaign" });
    expect(anotherRun.cycles.every((cycle) => !first.cycles.some((other) => other.cycleId === cycle.cycleId))).toBe(true);
  });

  test("jitters openings throughout day and night while retaining separated slots", () => {
    const plan = createObservationPlan(input);
    const slotMs = DAY_MS / 20;
    for (let day = 1; day <= 7; day += 1) {
      const cycles = plan.cycles.filter((cycle) => cycle.day === day);
      const dayStart = plan.startAt + (day - 1) * DAY_MS;
      for (let index = 0; index < cycles.length; index += 1) {
        const cycle = cycles[index]!;
        const slotStart = dayStart + index * slotMs;
        expect(cycle.plannedOpenAt).toBeGreaterThan(slotStart);
        expect(cycle.plannedOpenAt).toBeLessThan(slotStart + slotMs);
        if (index > 0) expect(cycle.plannedOpenAt - cycles[index - 1]!.plannedOpenAt).toBeGreaterThan(20 * MINUTE_MS);
      }
      expect(cycles.some((cycle) => cycle.plannedOpenAt - dayStart < 6 * HOUR_MS)).toBe(true);
      expect(cycles.some((cycle) => cycle.plannedOpenAt - dayStart >= 18 * HOUR_MS)).toBe(true);
      const offsets = cycles.map((cycle, index) => cycle.plannedOpenAt - dayStart - index * slotMs);
      expect(new Set(offsets).size).toBeGreaterThan(1);
    }
  });

  test("reserves final-day room and keeps every nominal hold within the campaign across many seeds", () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const plan = createObservationPlan({ ...input, seed: `seed-${seed}` });
      for (const cycle of plan.cycles) {
        expect(cycle.plannedOpenAt + cycle.holdDurationMs).toBeLessThanOrEqual(plan.endsAt);
      }
      const finalDayStart = plan.endsAt - DAY_MS;
      for (const cycle of plan.cycles.filter((cycle) => cycle.day === 7 && cycle.holdClass === "long")) {
        expect(cycle.plannedOpenAt).toBeLessThanOrEqual(finalDayStart + 12 * HOUR_MS);
      }
    }
  });

  test("starts the hold at actual settled open and allows late positions to drain after the cutoff", () => {
    const plan = createObservationPlan(input);
    const cycle = plan.cycles.at(-1)!;
    const actualOpen = plan.endsAt - MINUTE_MS;
    expect(observationCloseDueAt(cycle, actualOpen)).toBe(actualOpen + cycle.holdDurationMs);
    expect(observationCloseDueAt(cycle, actualOpen)).toBeGreaterThan(plan.endsAt);
    expect(observationCloseDueAt(cycle, actualOpen)).toBeGreaterThan(cycle.plannedOpenAt + cycle.holdDurationMs);
  });

  test("requires a persisted campaign identity, seed, and explicit unambiguous start", () => {
    expect(() => createObservationPlan({ ...input, runId: " " })).toThrow("runId");
    expect(() => createObservationPlan({ ...input, seed: "" })).toThrow("seed");
    for (const startAt of [NaN, Infinity, -1, 1.5, "2026-10-30", "2026-10-30T09:00:00", "invalid", new Date(NaN)]) {
      expect(() => createObservationPlan({ ...input, startAt })).toThrow("startAt");
    }
    expect(() => observationCloseDueAt({ holdDurationMs: 0 }, 1)).toThrow("holdDurationMs");
    expect(() => observationCloseDueAt({ holdDurationMs: MINUTE_MS }, NaN)).toThrow("settledOpenAt");
  });
});
