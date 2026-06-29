export interface VammState {
  baseReserve: bigint;
  quoteReserve: bigint;
}

export function invariant(state: VammState): bigint {
  return state.baseReserve * state.quoteReserve;
}

export function routeResidual(state: VammState, signedBaseDelta: bigint): VammState {
  if (signedBaseDelta === 0n) return state;
  const k = invariant(state);
  const nextBase = state.baseReserve - signedBaseDelta;
  if (nextBase <= 0n) throw new Error("invalid vamm base reserve");
  const nextQuote = k / nextBase;
  return { baseReserve: nextBase, quoteReserve: nextQuote };
}
