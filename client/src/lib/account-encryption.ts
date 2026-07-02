import { registerPendingConditionalOrdersForPosition } from "@/lib/conditional-orders";
import { pnlxPost } from "@/lib/pnlx-api";
import type { ServerAccountEvent } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

const DB_NAME = "pnlx-account-encryption";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const CIPHERTEXT_PREFIX = "pnlx-account-event-v1:";

interface StoredAccountKey {
  ownerCommitment: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyRaw: string;
}

interface AccountEventEnvelope {
  alg: "ecdh-p256-aes-gcm";
  ciphertext: string;
  ephemeralPublicKey: string;
  iv: string;
  tag: string;
  v: 1;
}

export type PrivateAccountEventPayload =
  | {
      kind: "position-opening";
      opening: {
        entryPrice: string;
        fundingIndex: string;
        margin: string;
        marketId: string;
        positionCommitment: `0x${string}`;
        positionNullifier: `0x${string}`;
        side: "long" | "short";
        size: string;
        sourceIntentCommitment: `0x${string}`;
      };
    }
  | {
      kind: "position-close" | "liquidation" | "residual-order";
      [key: string]: unknown;
    };

export async function ensureAccountEncryptionKey(session: WalletSession): Promise<void> {
  const key = await getOrCreateAccountKey(session.ownerCommitment);
  await pnlxPost(
    "/account-keys",
    {
      algorithm: "ecdh-p256-aes-gcm",
      ownerCommitment: session.ownerCommitment,
      publicKey: key.publicKeyRaw,
    },
    session.token,
  );
}

export async function syncPrivateConditionalOrders(
  session: WalletSession,
  accountEvents: ServerAccountEvent[],
): Promise<void> {
  if (accountEvents.length === 0) return;
  await ensureAccountEncryptionKey(session);
  for (const event of accountEvents) {
    const payload = await decryptAccountEvent<PrivateAccountEventPayload>(
      session.ownerCommitment,
      event.ciphertext,
    ).catch(() => undefined);
    if (payload?.kind !== "position-opening" || !payload.opening) continue;
    await registerPendingConditionalOrdersForPosition(session, {
      kind: "position-opening",
      ...payload.opening,
    });
  }
}

export async function decryptAccountEvent<T>(ownerCommitment: string, ciphertext: string): Promise<T> {
  if (!ciphertext.startsWith(CIPHERTEXT_PREFIX)) {
    throw new Error("unsupported account event ciphertext");
  }
  const key = await getStoredAccountKey(ownerCommitment);
  if (!key) throw new Error("account encryption key is missing");

  const envelope = JSON.parse(
    bytesToText(base64UrlToBytes(ciphertext.slice(CIPHERTEXT_PREFIX.length))),
  ) as AccountEventEnvelope;
  if (envelope.v !== 1 || envelope.alg !== "ecdh-p256-aes-gcm") {
    throw new Error("unsupported account event envelope");
  }

  const ephemeralPublicKey = await globalThis.crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64UrlToBytes(envelope.ephemeralPublicKey)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const aesKey = await globalThis.crypto.subtle.deriveKey(
    { name: "ECDH", public: ephemeralPublicKey },
    key.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plaintext = await globalThis.crypto.subtle.decrypt(
    {
      iv: toArrayBuffer(base64UrlToBytes(envelope.iv)),
      name: "AES-GCM",
      tagLength: 128,
    },
    aesKey,
    toArrayBuffer(concatBytes(base64UrlToBytes(envelope.ciphertext), base64UrlToBytes(envelope.tag))),
  );

  return JSON.parse(bytesToText(new Uint8Array(plaintext))) as T;
}

async function getOrCreateAccountKey(ownerCommitment: string): Promise<StoredAccountKey> {
  const existing = await getStoredAccountKey(ownerCommitment);
  if (existing) return existing;

  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
  const publicKeyRaw = bytesToBase64Url(
    new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  const stored = {
    ownerCommitment,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyRaw,
  };
  await putStoredAccountKey(stored);
  return stored;
}

async function getStoredAccountKey(ownerCommitment: string): Promise<StoredAccountKey | undefined> {
  return requestToPromise<StoredAccountKey | undefined>(
    (await openDb()).transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(ownerCommitment),
  );
}

async function putStoredAccountKey(key: StoredAccountKey): Promise<void> {
  await requestToPromise(
    (await openDb()).transaction(KEY_STORE, "readwrite").objectStore(KEY_STORE).put(key),
  );
}

async function openDb(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) {
    throw new Error("Account encryption is unavailable in this browser");
  }
  const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(KEY_STORE)) {
      db.createObjectStore(KEY_STORE, { keyPath: "ownerCommitment" });
    }
  };
  return requestToPromise(request);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
