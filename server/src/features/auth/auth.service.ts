import {
  createPublicKey,
  createHash,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { ownerCommitment } from "@pnlx/crypto";
import type {
  AuthChallengeInput,
  AuthChallengeResult,
  AuthSession,
  AuthSessionInput,
  AuthSessionResult,
} from "@/features/auth/auth.model";
import type { AuthContext } from "@/shared/http/auth-context";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_PUBLIC_KEY_VERSION = 6 << 3;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const STELLAR_SIGNED_MESSAGE_PREFIX = "Stellar Signed Message:\n";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingChallenge {
  address: string;
  expiresAt: number;
  message: string;
}

export class AuthService {
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly sessions = new Map<string, AuthSession>();

  constructor(
    private readonly networkPassphrase: string,
  ) {}

  challenge(input: AuthChallengeInput): AuthChallengeResult {
    const address = input.address.trim().toUpperCase();
    decodeStellarPublicKey(address);

    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    const domain = input.domain?.trim() || "pnlx.local";
    const uri = input.uri?.trim() || `https://${domain}`;
    const message = [
      "PNLX authentication",
      `Address: ${address}`,
      `Domain: ${domain}`,
      `URI: ${uri}`,
      `Network: ${this.networkPassphrase}`,
      `Nonce: ${nonce}`,
      `Expires At: ${expiresAt}`,
    ].join("\n");

    this.challenges.set(nonce, { address, expiresAt, message });
    return {
      address,
      domain,
      expiresAt,
      message,
      networkPassphrase: this.networkPassphrase,
      nonce,
      ownerCommitment: ownerCommitment(address),
      signingMode: "stellar-ed25519-message",
      uri,
    };
  }

  session(input: AuthSessionInput): AuthSessionResult {
    const address = input.address.trim().toUpperCase();
    const challenge = this.challenges.get(input.nonce);
    if (!challenge) throw new Error("auth challenge not found");
    if (challenge.expiresAt < Date.now()) {
      this.challenges.delete(input.nonce);
      throw new Error("auth challenge expired");
    }
    if (challenge.address !== address) throw new Error("auth address mismatch");

    const publicKey = decodeStellarPublicKey(address);
    const signature = Buffer.from(input.signature, "base64");
    const verified = verifyStellarSignedMessage(publicKey, challenge.message, signature);
    if (!verified) throw new Error("invalid auth signature");

    this.challenges.delete(input.nonce);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(sessionKey(token), { address, expiresAt });

    return {
      address,
      expiresAt,
      networkPassphrase: this.networkPassphrase,
      ownerCommitment: ownerCommitment(address),
      signingMode: "stellar-ed25519-message",
      token,
    };
  }

  authenticateRequest(request: Request): AuthContext | Response {
    const header = request.headers.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      return Response.json({ error: "missing auth token" }, { status: 401 });
    }

    const session = this.sessions.get(sessionKey(token));
    if (!session) {
      return Response.json({ error: "invalid auth token" }, { status: 401 });
    }
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(sessionKey(token));
      return Response.json({ error: "expired auth token" }, { status: 401 });
    }
    return { address: session.address, expiresAt: session.expiresAt };
  }
}

function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function decodeStellarPublicKey(address: string): Buffer {
  const decoded = base32Decode(address);
  if (decoded.length !== 35) throw new Error("invalid stellar address length");

  const payload = decoded.subarray(0, 33);
  const checksum = decoded.subarray(33);
  const expected = crc16Xmodem(payload);
  if (checksum[0] !== (expected & 0xff) || checksum[1] !== (expected >> 8)) {
    throw new Error("invalid stellar address checksum");
  }
  if (payload[0] !== ED25519_PUBLIC_KEY_VERSION) {
    throw new Error("invalid stellar address version");
  }

  return payload.subarray(1);
}

export function encodeStellarPublicKey(publicKey: Buffer): string {
  if (publicKey.length !== 32) throw new Error("stellar public key must be 32 bytes");

  const payload = Buffer.concat([Buffer.from([ED25519_PUBLIC_KEY_VERSION]), publicKey]);
  const checksum = crc16Xmodem(payload);
  return base32Encode(Buffer.concat([payload, Buffer.from([checksum & 0xff, checksum >> 8])]));
}

export function stellarSignedMessageHash(message: string): Buffer {
  return createHash("sha256")
    .update(Buffer.from(STELLAR_SIGNED_MESSAGE_PREFIX, "utf8"))
    .update(Buffer.from(message, "utf8"))
    .digest();
}

function verifyStellarSignedMessage(publicKey: Buffer, message: string, signature: Buffer): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, stellarSignedMessageHash(message), key, signature);
  } catch {
    return false;
  }
}

function base32Decode(value: string): Buffer {
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (const char of value.replace(/=+$/g, "").toUpperCase()) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid stellar address character");
    bits = (bits << 5) | index;
    bitCount += 5;
    while (bitCount >= 8) {
      bytes.push((bits >> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }

  return Buffer.from(bytes);
}

function base32Encode(value: Buffer): string {
  let bits = 0;
  let bitCount = 0;
  let out = "";

  for (const byte of value) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      out += BASE32_ALPHABET[(bits >> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }

  if (bitCount > 0) {
    out += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  }

  return out;
}

function crc16Xmodem(value: Buffer): number {
  let crc = 0;
  for (const byte of value) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
