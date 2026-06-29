import type { CreateAccountEventInput, ListAccountEventsInput } from "./account-events.model";

type AccountEventBody = Record<string, unknown>;

export function parseAccountEvent(input: AccountEventBody): CreateAccountEventInput {
  const ciphertext = String(input.ciphertext ?? "").trim();
  if (!ciphertext) throw new Error("ciphertext is required");

  return {
    ciphertext,
    dataCommitment: hex(input.dataCommitment, "dataCommitment"),
    eventId: hex(input.eventId, "eventId"),
    ownerCommitment: hex(input.ownerCommitment, "ownerCommitment"),
  };
}

export function parseAccountEventList(request: Request): ListAccountEventsInput {
  const ownerCommitment = new URL(request.url).searchParams.get("ownerCommitment");
  return {
    ownerCommitment: hex(ownerCommitment, "ownerCommitment"),
  };
}

function hex(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${field} must be hex`);
  }
  return value.toLowerCase() as `0x${string}`;
}
