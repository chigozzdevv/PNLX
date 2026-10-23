import { pnlxPost } from "@/lib/pnlx-api";
import { currentPrivateMarginNoteRuntimeScope } from "@/lib/private-margin-notes";
import { digestToFieldHex, fieldHashPair, randomLabel } from "@/lib/private-note";
import type { Hex, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

const STRATEGY_KEY = "pnlx.private.conditional-strategies";
type ConditionalKind = "take-profit" | "stop-loss";

export interface PrivatePositionOpeningEvent {
  kind: "position-opening";
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  side: Side;
  size: string;
  sourceIntentCommitment: Hex;
}

interface ConditionalRegistration {
  closeCommitment: Hex;
  kind: ConditionalKind;
  salt: string;
  status: "pending" | "registered";
  triggerPrice: string;
}

export interface PrivateConditionalProtection {
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  registrations: ConditionalRegistration[];
  runtimeScope: string;
  side: Side;
  size: string;
}

export interface PendingConditionalStrategy {
  createdAt: number;
  entryLimitPrice: string;
  intentCommitment: Hex;
  leverage: number;
  margin: string;
  marketId: string;
  ownerCommitment: Hex;
  protections?: Record<string, PrivateConditionalProtection>;
  runtimeScope?: string;
  side: Side;
  size: string;
  status: "pending-position" | "registered";
  stopLossCloseCommitment?: Hex | null;
  stopLossPrice?: string | null;
  stopLossSalt?: string | null;
  takeProfitCloseCommitment?: Hex | null;
  takeProfitPrice?: string | null;
  takeProfitSalt?: string | null;
}

interface ConditionalOrderRegistrationResponse {
  conditionalOrder: {
    closeCommitment: Hex;
    marketId: string;
    positionNullifier: Hex;
  };
}

const registrationsInFlight = new Map<string, Promise<ConditionalOrderRegistrationResponse["conditionalOrder"][]>>();

export function storePendingConditionalStrategy(
  input: Omit<PendingConditionalStrategy, "createdAt" | "runtimeScope" | "status">,
): PendingConditionalStrategy | undefined {
  if (typeof window === "undefined") return undefined;
  const runtimeScope = requiredScope();
  const existing = readPendingConditionalStrategies();
  const current = existing.find((candidate) => strategyMatches(candidate, input, runtimeScope));
  if (current) return current;
  const strategy: PendingConditionalStrategy = {
    ...input, createdAt: Date.now(), runtimeScope, status: "pending-position",
    stopLossSalt: input.stopLossPrice ? input.stopLossSalt ?? randomLabel("stop-loss") : undefined,
    takeProfitSalt: input.takeProfitPrice ? input.takeProfitSalt ?? randomLabel("take-profit") : undefined,
  };
  writePendingConditionalStrategies([...existing, strategy]);
  return strategy;
}

export function inheritPendingConditionalStrategy(
  session: WalletSession,
  residual: { intentCommitment: Hex; marketId: string; ownerCommitment: Hex; sourceIntentCommitment: Hex },
): boolean {
  if (typeof window === "undefined" || !sameHex(residual.ownerCommitment, session.ownerCommitment)) return false;
  const scope = requiredScope();
  const strategies = readPendingConditionalStrategies();
  if (strategies.some((candidate) => strategyMatches(candidate, { ...residual, ownerCommitment: session.ownerCommitment }, scope))) return false;
  const source = strategies.find((candidate) => strategyMatches(candidate, {
    intentCommitment: residual.sourceIntentCommitment, marketId: residual.marketId, ownerCommitment: session.ownerCommitment,
  }, scope));
  if (!source) return false;
  writePendingConditionalStrategies([...strategies, {
    ...source, createdAt: Date.now(), intentCommitment: residual.intentCommitment, protections: {},
    runtimeScope: scope, status: "pending-position", stopLossCloseCommitment: undefined, takeProfitCloseCommitment: undefined,
  }]);
  return true;
}

export async function registerPendingConditionalOrdersForPosition(
  session: WalletSession,
  opening: PrivatePositionOpeningEvent,
): Promise<ConditionalOrderRegistrationResponse["conditionalOrder"][]> {
  if (typeof window === "undefined") return [];
  const scope = requiredScope();
  const key = `${scope}:${session.ownerCommitment.toLowerCase()}:${opening.marketId}:${opening.positionCommitment.toLowerCase()}`;
  const existing = registrationsInFlight.get(key);
  if (existing) return existing;
  const operation = withRegistrationLock(key, () => registerForPosition(session, opening, scope));
  registrationsInFlight.set(key, operation);
  try {
    return await operation;
  } finally {
    if (registrationsInFlight.get(key) === operation) registrationsInFlight.delete(key);
  }
}

async function registerForPosition(
  session: WalletSession,
  opening: PrivatePositionOpeningEvent,
  scope: string,
): Promise<ConditionalOrderRegistrationResponse["conditionalOrder"][]> {
  const identity = { intentCommitment: opening.sourceIntentCommitment, marketId: opening.marketId, ownerCommitment: session.ownerCommitment };
  let strategy = readPendingConditionalStrategies().find((candidate) => strategyMatches(candidate, identity, scope));
  if (!strategy) return [];
  if (strategy.side !== opening.side || BigInt(opening.size) <= 0n) throw new Error("Conditional position does not match its policy");
  const positionKey = opening.positionCommitment.toLowerCase();
  let protection = strategy.protections?.[positionKey];
  if (!protection) {
    // Persist salts before asynchronous work so retries retain the same commitments.
    strategy = updateStrategy(identity, scope, (current) => ({
      ...current, runtimeScope: scope,
      stopLossSalt: current.stopLossPrice ? current.stopLossSalt ?? randomLabel("stop-loss") : undefined,
      takeProfitSalt: current.takeProfitPrice ? current.takeProfitSalt ?? randomLabel("take-profit") : undefined,
    }));
    const registrations: ConditionalRegistration[] = [];
    for (const kind of ["take-profit", "stop-loss"] as const) {
      const triggerPrice = kind === "take-profit" ? strategy.takeProfitPrice : strategy.stopLossPrice;
      const baseSalt = kind === "take-profit" ? strategy.takeProfitSalt : strategy.stopLossSalt;
      if (!triggerPrice || !baseSalt) continue;
      if (BigInt(triggerPrice) <= 0n) throw new Error("Conditional trigger price must be positive");
      const salt = `${baseSalt}:${opening.positionCommitment.toLowerCase()}:${opening.positionNullifier.toLowerCase()}`;
      const closeCommitment = await conditionalOrderCommitment({
        kind, marketId: opening.marketId, positionNullifier: opening.positionNullifier,
        reduceOnly: true, salt, side: opening.side, size: BigInt(opening.size), triggerPrice: BigInt(triggerPrice),
      });
      registrations.push({ closeCommitment, kind, salt, status: "pending", triggerPrice });
    }
    const prepared: PrivateConditionalProtection = {
      marketId: opening.marketId, positionCommitment: opening.positionCommitment,
      positionNullifier: opening.positionNullifier, registrations, runtimeScope: scope,
      side: opening.side, size: opening.size,
    };
    strategy = updateStrategy(identity, scope, (current) => ({
      ...current, protections: { ...current.protections, [positionKey]: current.protections?.[positionKey] ?? prepared },
    }));
    protection = strategy.protections![positionKey];
  }
  if (protection.marketId !== opening.marketId || !sameHex(protection.positionNullifier, opening.positionNullifier) ||
      protection.size !== opening.size || protection.side !== opening.side || protection.runtimeScope !== scope) {
    throw new Error("Stored conditional protection does not match the position");
  }
  const registered: ConditionalOrderRegistrationResponse["conditionalOrder"][] = [];
  for (const registration of protection.registrations) {
    if (registration.status === "registered") continue;
    assertScope(scope);
    const response = await pnlxPost<ConditionalOrderRegistrationResponse>("/conditional-orders", {
      closeCommitment: registration.closeCommitment, marketId: opening.marketId, positionNullifier: opening.positionNullifier,
    }, session.token);
    const result = response.conditionalOrder;
    if (!result || !sameHex(result.closeCommitment, registration.closeCommitment) ||
        result.marketId !== opening.marketId || !sameHex(result.positionNullifier, opening.positionNullifier)) {
      throw new Error("Conditional registration confirmation does not match the position");
    }
    updateStrategy(identity, scope, (current) => {
      const stored = current.protections?.[positionKey];
      if (!stored) throw new Error("Conditional protection is unavailable");
      const registrations = stored.registrations.map((value) => sameHex(value.closeCommitment, registration.closeCommitment)
        ? { ...value, status: "registered" as const } : value);
      return { ...current, status: "registered", protections: { ...current.protections, [positionKey]: { ...stored, registrations } } };
    });
    registered.push(result);
  }
  return registered;
}

export async function conditionalOrderCommitment(input: {
  kind: ConditionalKind;
  marketId: string;
  positionNullifier: Hex;
  reduceOnly: boolean;
  salt: string;
  side: Side;
  size: bigint;
  triggerPrice: bigint;
}): Promise<Hex> {
  const marketDigest = await digestToFieldHex(`pnlx:market-id:${input.marketId}`);
  const saltDigest = await digestToFieldHex(`salt:${input.salt}`);
  const side = input.side === "long" ? 1n : 2n;
  const kind = input.kind === "take-profit" ? 1n : 2n;
  const reduceOnly = input.reduceOnly ? 1n : 0n;
  const scope = fieldHashPair(fieldHashPair(marketDigest, input.positionNullifier), fieldHashPair(side, kind));
  const trigger = fieldHashPair(fieldHashPair(input.triggerPrice, input.size), fieldHashPair(reduceOnly, saltDigest));
  return fieldHashPair(scope, trigger);
}

function updateStrategy(
  identity: Pick<PendingConditionalStrategy, "intentCommitment" | "marketId" | "ownerCommitment">,
  scope: string,
  transform: (strategy: PendingConditionalStrategy) => PendingConditionalStrategy,
): PendingConditionalStrategy {
  assertScope(scope);
  const strategies = readPendingConditionalStrategies();
  const index = strategies.findIndex((candidate) => strategyMatches(candidate, identity, scope));
  if (index < 0) throw new Error("Conditional policy is unavailable");
  const updated = transform(strategies[index]);
  strategies[index] = updated;
  writePendingConditionalStrategies(strategies);
  return updated;
}

function strategyMatches(
  strategy: PendingConditionalStrategy,
  identity: Pick<PendingConditionalStrategy, "intentCommitment" | "marketId" | "ownerCommitment">,
  scope: string,
): boolean {
  return (!strategy.runtimeScope || strategy.runtimeScope === scope) && strategy.marketId === identity.marketId &&
    sameHex(strategy.intentCommitment, identity.intentCommitment) && sameHex(strategy.ownerCommitment, identity.ownerCommitment);
}

function readPendingConditionalStrategies(): PendingConditionalStrategy[] {
  const raw = window.localStorage.getItem(STRATEGY_KEY);
  if (!raw) return [];
  try {
    const strategies: unknown = JSON.parse(raw);
    if (!Array.isArray(strategies)) throw new Error("Conditional policy storage is not a list");
    return strategies.filter((value): value is PendingConditionalStrategy => Boolean(value) && typeof value === "object" &&
      typeof value.intentCommitment === "string" && typeof value.ownerCommitment === "string" && typeof value.marketId === "string");
  } catch (cause) {
    throw new Error("Private conditional policy storage is unreadable", { cause });
  }
}

function writePendingConditionalStrategies(strategies: PendingConditionalStrategy[]): void {
  window.localStorage.setItem(STRATEGY_KEY, JSON.stringify(strategies));
}

function requiredScope(): string {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Conditional policy runtime scope is unavailable");
  return scope;
}

function assertScope(scope: string): void {
  if (requiredScope() !== scope) throw new Error("Conditional policy runtime changed; refresh and retry");
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function withRegistrationLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(`pnlx:conditional:${key}`, run);
  }
  return run();
}
