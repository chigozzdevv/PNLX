/**
 * Versioned, deterministic inputs for a single seven-day observation campaign.
 * Persist this plan before starting work and reuse it on restart. This module
 * never reads the wall clock, submits trades, or infers that a trade completed.
 */
export const OBSERVATION_PLAN_VERSION = 1 as const;
export const OBSERVATION_DAYS = 7 as const;
export const OBSERVATION_CYCLES_PER_DAY = 20 as const;
export const OBSERVATION_MAX_CONCURRENT = 3 as const;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const OBSERVATION_MARKETS = ["XLM"] as const;
export const OBSERVATION_MARGINS_USDC = [10, 25, 50, 100] as const;
export const OBSERVATION_LEVERAGES = [1, 2, 3, 5, 8] as const;

export type ObservationMarket = (typeof OBSERVATION_MARKETS)[number];
export type ObservationSide = "long" | "short";
export type ObservationHoldClass = "short" | "medium" | "long";

export interface ObservationCyclePlan {
  readonly runId: string;
  readonly cycleId: string;
  /** One-based day, relative to the explicitly supplied campaign start. */
  readonly day: number;
  /** One-based sequence across the campaign. */
  readonly sequence: number;
  /** One-based sequence within this campaign day. */
  readonly daySequence: number;
  /** Epoch milliseconds: eligibility to open, never evidence of settlement. */
  readonly plannedOpenAt: number;
  /** Starts at actual confirmed open settlement, not plannedOpenAt. */
  readonly holdDurationMs: number;
  readonly holdClass: ObservationHoldClass;
  readonly market: ObservationMarket;
  readonly side: ObservationSide;
  readonly marginUsdc: (typeof OBSERVATION_MARGINS_USDC)[number];
  /** Requested leverage; the trade adapter must clamp to the market maximum. */
  readonly leverage: (typeof OBSERVATION_LEVERAGES)[number];
}

export interface ObservationPlan {
  readonly version: typeof OBSERVATION_PLAN_VERSION;
  readonly runId: string;
  readonly seed: string;
  readonly startAt: number;
  /** Stop opening at this cutoff; drain confirmed positions safely afterward. */
  readonly endsAt: number;
  readonly days: typeof OBSERVATION_DAYS;
  readonly cyclesPerDay: typeof OBSERVATION_CYCLES_PER_DAY;
  readonly cycles: readonly ObservationCyclePlan[];
}

export interface ObservationPlanInput {
  runId: string;
  seed: string;
  /** Epoch milliseconds, Date, or ISO timestamp with an explicit UTC offset. */
  startAt: number | string | Date;
}

const HOLD_RANGES_MINUTES: Record<ObservationHoldClass, readonly [number, number]> = {
  short: [5, 30],
  medium: [60, 180],
  long: [360, 720],
};

function timestamp(value: number | string | Date, name: string): number {
  if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${name} must include an explicit UTC offset`);
  }
  const result = typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 8_640_000_000_000_000 - OBSERVATION_DAYS * DAY_MS) {
    throw new Error(`${name} must be a valid nonnegative epoch timestamp`);
  }
  return result;
}

/** FNV-1a + Mulberry32; keep this algorithm stable for version 1 plans. */
function randomFromSeed(seed: string): () => number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function dayHolds(day: number, random: () => number): ObservationHoldClass[] {
  if (day < OBSERVATION_DAYS) {
    return shuffled<ObservationHoldClass>([
      ...Array<ObservationHoldClass>(12).fill("short"),
      ...Array<ObservationHoldClass>(6).fill("medium"),
      "long", "long",
    ], random);
  }

  // Reserve room for the entire requested hold range on the final day. Long
  // opens fit within its first 12 hours; medium opens fit before its last 3.
  const result = Array<ObservationHoldClass>(OBSERVATION_CYCLES_PER_DAY).fill("short");
  const longSlots = shuffled(Array.from({ length: 10 }, (_, index) => index), random).slice(0, 2);
  for (const slot of longSlots) result[slot] = "long";
  const mediumSlots = shuffled(
    Array.from({ length: 17 }, (_, index) => index).filter((index) => result[index] === "short"),
    random,
  ).slice(0, 6);
  for (const slot of mediumSlots) result[slot] = "medium";
  return result;
}

export function createObservationPlan(input: ObservationPlanInput): ObservationPlan {
  if (!input.runId.trim()) throw new Error("runId must not be empty");
  if (!input.seed.trim()) throw new Error("seed must not be empty");
  const startAt = timestamp(input.startAt, "startAt");
  const endsAt = startAt + OBSERVATION_DAYS * DAY_MS;
  const cycles: ObservationCyclePlan[] = [];
  const slotMs = DAY_MS / OBSERVATION_CYCLES_PER_DAY;

  for (let day = 1; day <= OBSERVATION_DAYS; day += 1) {
    const random = randomFromSeed(JSON.stringify([OBSERVATION_PLAN_VERSION, input.runId, input.seed, startAt, day]));
    const holds = dayHolds(day, random);
    // Every day uses the supported XLM market, both sides, five of each margin,
    // and four of each requested leverage.
    const exposures = shuffled(Array.from({ length: OBSERVATION_CYCLES_PER_DAY }, (_, index) => ({
      market: OBSERVATION_MARKETS[0],
      side: (index % 2 === 0 ? "long" : "short") as ObservationSide,
    })), random);
    const margins = shuffled(Array.from({ length: OBSERVATION_CYCLES_PER_DAY }, (_, index) =>
      OBSERVATION_MARGINS_USDC[index % OBSERVATION_MARGINS_USDC.length]!), random);
    const leverages = shuffled(Array.from({ length: OBSERVATION_CYCLES_PER_DAY }, (_, index) =>
      OBSERVATION_LEVERAGES[index % OBSERVATION_LEVERAGES.length]!), random);

    for (let slot = 0; slot < OBSERVATION_CYCLES_PER_DAY; slot += 1) {
      const holdClass = holds[slot]!;
      const [minimum, maximum] = HOLD_RANGES_MINUTES[holdClass];
      const holdDurationMs = (minimum + Math.floor(random() * (maximum - minimum + 1))) * MINUTE_MS;
      const slotStart = startAt + (day - 1) * DAY_MS + slot * slotMs;
      const earliestOpen = slotStart + Math.floor(slotMs * 0.15);
      const latestOpen = Math.min(slotStart + Math.floor(slotMs * 0.85), endsAt - holdDurationMs);
      const plannedOpenAt = earliestOpen + Math.floor(random() * (latestOpen - earliestOpen + 1));
      const daySequence = slot + 1;
      cycles.push({
        runId: input.runId,
        cycleId: `${input.runId}:day-${day}:cycle-${daySequence}`,
        day,
        sequence: (day - 1) * OBSERVATION_CYCLES_PER_DAY + daySequence,
        daySequence,
        plannedOpenAt,
        holdDurationMs,
        holdClass,
        ...exposures[slot]!,
        marginUsdc: margins[slot]!,
        leverage: leverages[slot]!,
      });
    }
  }

  return {
    version: OBSERVATION_PLAN_VERSION,
    runId: input.runId,
    seed: input.seed,
    startAt,
    endsAt,
    days: OBSERVATION_DAYS,
    cyclesPerDay: OBSERVATION_CYCLES_PER_DAY,
    cycles,
  };
}

/**
 * A close becomes eligible only after the actual open has settled and its hold
 * elapsed. Eligibility is not proof of close submission or close settlement.
 * Late opens can deliberately drain beyond the campaign's opening cutoff.
 */
export function observationCloseDueAt(cycle: Pick<ObservationCyclePlan, "holdDurationMs">, settledOpenAt: number): number {
  const openedAt = timestamp(settledOpenAt, "settledOpenAt");
  if (!Number.isSafeInteger(cycle.holdDurationMs) || cycle.holdDurationMs <= 0) {
    throw new Error("holdDurationMs must be a positive integer");
  }
  const closeDueAt = openedAt + cycle.holdDurationMs;
  if (!Number.isSafeInteger(closeDueAt) || closeDueAt > 8_640_000_000_000_000) {
    throw new Error("close due timestamp is out of range");
  }
  return closeDueAt;
}
