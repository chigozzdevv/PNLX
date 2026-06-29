import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";

export function assertSubmittedRelay(
  result: OnchainRelayResult | undefined,
  functionName: string,
): void {
  const submitted = result?.relays.some((relay) =>
    relay.functionName === functionName &&
    relay.submitted &&
    Boolean(relay.txHash),
  );
  if (!submitted) {
    throw new Error(`${functionName} transaction was not submitted`);
  }
}
