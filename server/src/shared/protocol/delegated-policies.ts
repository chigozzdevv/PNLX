import type { Hex } from "@pnlx/protocol-types";
import type { ProtocolStore } from "@/shared/state/store";

export interface DelegatedConditionalPolicyInput {
  stopLossPrice?: string;
  stopLossSalt?: string;
  takeProfitPrice?: string;
  takeProfitSalt?: string;
}

export interface DelegatedConditionalPolicy extends DelegatedConditionalPolicyInput {
  createdAt: number;
  intentCommitment: Hex;
  marketId: string;
  ownerCommitment: Hex;
  reduceOnly: true;
}

type PolicyScope = Pick<DelegatedConditionalPolicy, "intentCommitment" | "marketId" | "ownerCommitment"> & {
  createdAt?: number;
};
const POLICY_FIELDS = new Set(["stopLossPrice", "stopLossSalt", "takeProfitPrice", "takeProfitSalt", "reduceOnly"]);
const MAX_U128 = (1n << 128n) - 1n;

/** Bind authenticated intent identity here, never take execution authority from the request body. */
export function createDelegatedConditionalPolicy(
  input: unknown,
  scope: PolicyScope,
): DelegatedConditionalPolicy | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid delegated conditional policy");
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !POLICY_FIELDS.has(key))) throw new Error("unsupported delegated conditional authority");
  if (fields.reduceOnly !== undefined && fields.reduceOnly !== true) throw new Error("delegated conditional policy must be reduce only");
  const policy: DelegatedConditionalPolicy = {
    createdAt: scope.createdAt ?? Date.now(),
    intentCommitment: normalizeCommitment(scope.intentCommitment),
    marketId: scope.marketId,
    ownerCommitment: normalizeCommitment(scope.ownerCommitment),
    reduceOnly: true,
  };
  if (!policy.marketId || !Number.isSafeInteger(policy.createdAt) || policy.createdAt < 0) throw new Error("invalid delegated conditional scope");
  for (const kind of ["stopLoss", "takeProfit"] as const) {
    const price = fields[`${kind}Price`];
    const salt = fields[`${kind}Salt`];
    if (price === undefined && salt === undefined) continue;
    if (typeof price !== "string" || !/^[0-9]+$/.test(price) || BigInt(price) <= 0n || BigInt(price) > MAX_U128) {
      throw new Error("delegated conditional trigger must be a positive u128 price");
    }
    if (typeof salt !== "string" || salt.length === 0 || salt.length > 256) throw new Error("invalid delegated conditional salt");
    policy[`${kind}Price`] = BigInt(price).toString();
    policy[`${kind}Salt`] = salt;
  }
  if (!policy.stopLossPrice && !policy.takeProfitPrice) throw new Error("delegated conditional policy has no triggers");
  return policy;
}

export function assertIdenticalDelegatedConditionalPolicy(
  previous: DelegatedConditionalPolicy,
  next: DelegatedConditionalPolicy,
): void {
  const fields: (keyof DelegatedConditionalPolicy)[] = [
    "intentCommitment", "marketId", "ownerCommitment", "reduceOnly", "stopLossPrice", "stopLossSalt", "takeProfitPrice", "takeProfitSalt",
  ];
  if (fields.some((field) => previous[field] !== next[field])) throw new Error("conflicting delegated conditional policy");
}

/** Residual orders inherit only the original authenticated owner's policy in the same market. */
export function findDelegatedConditionalPolicy(
  store: Pick<ProtocolStore, "delegatedPolicies" | "residualOrders">,
  intentCommitment: Hex,
): DelegatedConditionalPolicy | undefined {
  let current = normalizeCommitment(intentCommitment);
  let ownerCommitment: Hex | undefined;
  let marketId: string | undefined;
  const visited = new Set<Hex>();
  while (!visited.has(current)) {
    visited.add(current);
    const policy = store.delegatedPolicies.get(current);
    if (policy) {
      if ((ownerCommitment && normalizeCommitment(policy.ownerCommitment) !== ownerCommitment) ||
          (marketId && policy.marketId !== marketId)) throw new Error("delegated conditional lineage scope mismatch");
      return policy;
    }
    const residual = store.residualOrders.get(current) ?? [...store.residualOrders.values()]
      .find((candidate) => normalizeCommitment(candidate.intentCommitment) === current);
    if (!residual) return undefined;
    const residualOwner = normalizeCommitment(residual.ownerCommitment);
    if ((ownerCommitment && residualOwner !== ownerCommitment) || (marketId && residual.marketId !== marketId)) {
      throw new Error("delegated conditional lineage scope mismatch");
    }
    ownerCommitment = residualOwner;
    marketId = residual.marketId;
    current = normalizeCommitment(residual.sourceIntentCommitment);
  }
  throw new Error("cyclic delegated conditional lineage");
}

export function deriveDelegatedConditionalSalt(baseSalt: string, positionCommitment: Hex, positionNullifier: Hex): string {
  return `${baseSalt}:${normalizeCommitment(positionCommitment)}:${normalizeCommitment(positionNullifier)}`;
}

function normalizeCommitment(value: Hex): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error("invalid delegated conditional commitment");
  return value.toLowerCase() as Hex;
}
