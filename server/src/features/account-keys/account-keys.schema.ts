import type { GetAccountKeyInput, UpsertAccountKeyInput } from "@/features/account-keys/account-keys.model";

type AccountKeyBody = Record<string, unknown>;

export function parseAccountKey(input: AccountKeyBody): UpsertAccountKeyInput {
  const algorithm = String(input.algorithm ?? "");
  if (algorithm !== "ecdh-p256-aes-gcm") {
    throw new Error("account encryption algorithm is unsupported");
  }
  const publicKey = String(input.publicKey ?? "").trim();
  assertPublicKey(publicKey);
  return {
    algorithm,
    ownerCommitment: hex(input.ownerCommitment, "ownerCommitment"),
    publicKey,
  };
}

export function parseAccountKeyQuery(request: Request): GetAccountKeyInput {
  const ownerCommitment = new URL(request.url).searchParams.get("ownerCommitment");
  return {
    ownerCommitment: hex(ownerCommitment, "ownerCommitment"),
  };
}

function assertPublicKey(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("account encryption public key must be base64url");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(`${normalized}${padding}`, "base64");
  if (decoded.length !== 65 || decoded[0] !== 4) {
    throw new Error("account encryption public key must be raw P-256");
  }
}

function hex(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${field} must be hex`);
  }
  return value.toLowerCase() as `0x${string}`;
}
