import { json, readJson } from "@/shared/http/json";
import { ownerCommitment } from "@pnlx/crypto";
import type { AuthService } from "@/features/auth/auth.service";
import { parseAuthChallenge, parseAuthSession } from "@/features/auth/auth.schema";

export class AuthController {
  constructor(private readonly auth: AuthService) {}

  async challenge(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(
      this.auth.challenge({
        ...parseAuthChallenge(body),
        ...requestOrigin(request),
      }),
      201,
    );
  }

  async session(request: Request): Promise<Response> {
    const body = await readJson<Record<string, unknown>>(request);
    return json(this.auth.session(parseAuthSession(body)), 201);
  }

  current(request: Request): Response {
    const auth = this.auth.authenticateRequest(request);
    if (auth instanceof Response) return auth;
    return json({
      address: auth.address,
      expiresAt: auth.expiresAt,
      ownerCommitment: ownerCommitment(auth.address),
      signingMode: "stellar-ed25519-message",
    });
  }
}

function requestOrigin(request: Request): { domain: string; uri: string } {
  const url = new URL(request.url);
  const origin = parseOrigin(request.headers.get("origin")) ?? url.origin;
  const domain = new URL(origin).host;
  return {
    domain,
    uri: origin,
  };
}

function parseOrigin(origin: string | null): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
}
