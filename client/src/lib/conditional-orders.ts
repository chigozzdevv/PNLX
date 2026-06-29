import { merklPost } from "@/lib/merkl-api";
import { digestToFieldHex, fieldHashPair, randomLabel } from "@/lib/private-note";
import type { Hex, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

const STRATEGY_KEY = "merkl.private.conditional-strategies";

export interface PrivatePositionOpeningEvent {
  kind: "position-opening";
  marketId: string;
  positionCommitment: Hex;
  positionNullifier: Hex;
  side: Side;
  size: string;
  sourceIntentCommitment: Hex;
}

interface PendingConditionalStrategy {
  createdAt: number;
  entryLimitPrice: string;
  intentCommitment: Hex;
  leverage: number;
  margin: string;
  marketId: string;
  ownerCommitment: Hex;
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

export async function registerPendingConditionalOrdersForPosition(
  session: WalletSession,
  opening: PrivatePositionOpeningEvent,
): Promise<ConditionalOrderRegistrationResponse["conditionalOrder"][]> {
  if (typeof window === "undefined") return [];

  const strategies = readPendingConditionalStrategies();
  const strategy = strategies.find(
    (candidate) =>
      candidate.intentCommitment === opening.sourceIntentCommitment &&
      candidate.marketId === opening.marketId &&
      candidate.ownerCommitment === session.ownerCommitment &&
      candidate.status === "pending-position",
  );
  if (!strategy) return [];

  const registrations = await Promise.all(
    [
      strategy.takeProfitPrice
        ? createRegistration(session, opening, strategy, "take-profit", BigInt(strategy.takeProfitPrice))
        : undefined,
      strategy.stopLossPrice
        ? createRegistration(session, opening, strategy, "stop-loss", BigInt(strategy.stopLossPrice))
        : undefined,
    ].filter((value): value is Promise<ConditionalOrderRegistrationResponse["conditionalOrder"]> =>
      Boolean(value),
    ),
  );

  writePendingConditionalStrategies(
    strategies.map((candidate) =>
      candidate === strategy
        ? {
            ...candidate,
            status: "registered",
            stopLossCloseCommitment:
              registrations.find((entry) => entry.closeCommitment === candidate.stopLossCloseCommitment)
                ?.closeCommitment ?? candidate.stopLossCloseCommitment,
            takeProfitCloseCommitment:
              registrations.find((entry) => entry.closeCommitment === candidate.takeProfitCloseCommitment)
                ?.closeCommitment ?? candidate.takeProfitCloseCommitment,
          }
        : candidate,
    ),
  );

  return registrations;
}

async function createRegistration(
  session: WalletSession,
  opening: PrivatePositionOpeningEvent,
  strategy: PendingConditionalStrategy,
  kind: "take-profit" | "stop-loss",
  triggerPrice: bigint,
): Promise<ConditionalOrderRegistrationResponse["conditionalOrder"]> {
  const saltField = kind === "take-profit" ? "takeProfitSalt" : "stopLossSalt";
  const salt = strategy[saltField] ?? randomLabel(kind);
  strategy[saltField] = salt;
  const closeCommitment = await conditionalOrderCommitment({
    kind,
    marketId: opening.marketId,
    positionNullifier: opening.positionNullifier,
    reduceOnly: true,
    salt,
    side: opening.side,
    size: BigInt(opening.size),
    triggerPrice,
  });
  if (kind === "take-profit") {
    strategy.takeProfitCloseCommitment = closeCommitment;
  } else {
    strategy.stopLossCloseCommitment = closeCommitment;
  }

  const response = await merklPost<ConditionalOrderRegistrationResponse>(
    "/conditional-orders",
    {
      closeCommitment,
      marketId: opening.marketId,
      positionNullifier: opening.positionNullifier,
    },
    session.token,
  );
  return response.conditionalOrder;
}

async function conditionalOrderCommitment(input: {
  kind: "take-profit" | "stop-loss";
  marketId: string;
  positionNullifier: Hex;
  reduceOnly: boolean;
  salt: string;
  side: Side;
  size: bigint;
  triggerPrice: bigint;
}): Promise<Hex> {
  const marketDigest = await digestToFieldHex(`market:${input.marketId}`);
  const saltDigest = await digestToFieldHex(`salt:${input.salt}`);
  const side = input.side === "long" ? 1n : 2n;
  const kind = input.kind === "take-profit" ? 1n : 2n;
  const reduceOnly = input.reduceOnly ? 1n : 0n;
  const scope = fieldHashPair(
    fieldHashPair(marketDigest, input.positionNullifier),
    fieldHashPair(side, kind),
  );
  const trigger = fieldHashPair(
    fieldHashPair(input.triggerPrice, input.size),
    fieldHashPair(reduceOnly, saltDigest),
  );
  return fieldHashPair(scope, trigger);
}

function readPendingConditionalStrategies(): PendingConditionalStrategy[] {
  const raw = window.localStorage.getItem(STRATEGY_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PendingConditionalStrategy[];
  } catch {
    return [];
  }
}

function writePendingConditionalStrategies(strategies: PendingConditionalStrategy[]): void {
  window.localStorage.setItem(STRATEGY_KEY, JSON.stringify(strategies));
}
