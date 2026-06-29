import type { AuthChallengeInput, AuthSessionInput } from "@/features/auth/auth.model";

type AuthBody = Record<string, unknown>;

export function parseAuthChallenge(input: AuthBody): AuthChallengeInput {
  return {
    address: String(input.address),
  };
}

export function parseAuthSession(input: AuthBody): AuthSessionInput {
  return {
    address: String(input.address),
    nonce: String(input.nonce),
    signature: String(input.signature),
  };
}
