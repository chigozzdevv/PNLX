import type { CreateRelayInput } from "@/features/relays/relays.model";
import type { SubmitSignedXdrInput } from "@/features/relays/relays.model";

type RelayBody = Record<string, unknown>;

const relayKinds = new Set([
  "deposit",
  "intent",
  "market",
  "batch-settlement",
  "withdraw",
  "conditional-order",
  "conditional-close",
  "position-close",
  "liquidation",
  "disclosure",
  "funding-settlement",
  "signed-xdr",
  "contract-invoke",
]);

export function parseRelay(input: RelayBody): CreateRelayInput {
  const kind = String(input.kind);
  if (!relayKinds.has(kind)) throw new Error("unsupported relay kind");

  return {
    kind: kind as CreateRelayInput["kind"],
    payload: input.payload,
  };
}

export function parseSignedXdr(input: RelayBody): SubmitSignedXdrInput {
  const xdr = String(input.xdr ?? "").trim();
  if (!xdr) throw new Error("signed transaction xdr is required");
  if (!/^[A-Za-z0-9+/=]+$/.test(xdr)) throw new Error("signed transaction xdr must be base64");
  return {
    commitment: optionalHex(input.commitment),
    preparedXdrDigest: optionalHex(input.preparedXdrDigest),
    xdr,
  };
}

function optionalHex(value: unknown): `0x${string}` | undefined {
  return value === undefined || value === "" ? undefined : (String(value) as `0x${string}`);
}
