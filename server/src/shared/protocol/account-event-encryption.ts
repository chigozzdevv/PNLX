import { createCipheriv, createECDH, createHash, randomBytes } from "node:crypto";

const ACCOUNT_EVENT_ALGORITHM = "ecdh-p256-aes-gcm";

export interface AccountEventCiphertextEnvelope {
  alg: typeof ACCOUNT_EVENT_ALGORITHM;
  ciphertext: string;
  ephemeralPublicKey: string;
  iv: string;
  tag: string;
  v: 1;
}

export function encryptAccountEventPayload(payload: unknown, recipientPublicKey: string): string {
  const recipient = base64UrlDecode(recipientPublicKey);
  if (recipient.length !== 65 || recipient[0] !== 4) {
    throw new Error("account encryption public key must be raw P-256");
  }

  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(recipient);
  const key = createHash("sha256").update(sharedSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload, bigintReplacer), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: AccountEventCiphertextEnvelope = {
    alg: ACCOUNT_EVENT_ALGORITHM,
    ciphertext: base64UrlEncode(ciphertext),
    ephemeralPublicKey: base64UrlEncode(ecdh.getPublicKey()),
    iv: base64UrlEncode(iv),
    tag: base64UrlEncode(tag),
    v: 1,
  };

  return `merkl-account-event-v1:${base64UrlEncode(Buffer.from(JSON.stringify(envelope), "utf8"))}`;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64");
}
