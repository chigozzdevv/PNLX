import { merklGet, merklPost } from "@/lib/merkl-api";
import { ensureAccountEncryptionKey } from "@/lib/account-encryption";

const STORAGE_KEY = "merkl.wallet.session";

interface AuthChallenge {
  address: string;
  expiresAt: number;
  message: string;
  nonce: string;
  ownerCommitment: `0x${string}`;
  signingMode: "stellar-ed25519-message";
}

export interface WalletSession {
  address: string;
  expiresAt: number;
  ownerCommitment: `0x${string}`;
  token: string;
}

interface AuthSessionResponse extends WalletSession {
  signingMode: "stellar-ed25519-message";
}

interface AuthSessionStatus {
  address: string;
  expiresAt: number;
  ownerCommitment: `0x${string}`;
  signingMode: "stellar-ed25519-message";
}

type FreighterResult = Promise<unknown>;

interface FreighterApi {
  getAddress?: () => FreighterResult;
  getPublicKey?: () => FreighterResult;
  requestAccess?: () => FreighterResult;
  signBlob?: (payload: Uint8Array) => FreighterResult;
  signMessage?: (message: string) => FreighterResult;
  signTransaction?: (xdr: string, options?: Record<string, unknown>) => FreighterResult;
}

declare global {
  interface Window {
    freighter?: FreighterApi;
    freighterApi?: FreighterApi;
  }
}

export async function connectWalletSession(): Promise<WalletSession> {
  const address = await requestWalletAddress();
  const challenge = await merklPost<AuthChallenge>("/auth/challenge", { address });
  const signature = await signChallenge(challenge.message);
  const session = await merklPost<AuthSessionResponse>("/auth/session", {
    address: challenge.address,
    nonce: challenge.nonce,
    signature,
  });
  const stored = {
    address: session.address,
    expiresAt: session.expiresAt,
    ownerCommitment: session.ownerCommitment,
    token: session.token,
  };
  storeWalletSession(stored);
  await ensureAccountEncryptionKey(stored);
  return stored;
}

export function readWalletSession(): WalletSession | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as Partial<WalletSession>;
    if (!session.address || !session.token || !session.ownerCommitment || !session.expiresAt) {
      clearWalletSession();
      return null;
    }
    if (session.expiresAt <= Date.now()) {
      clearWalletSession();
      return null;
    }
    return session as WalletSession;
  } catch {
    clearWalletSession();
    return null;
  }
}

export async function validateWalletSession(): Promise<WalletSession | null> {
  const stored = readWalletSession();
  if (!stored) return null;

  try {
    const current = await merklGet<AuthSessionStatus>("/auth/session", stored.token);
    if (
      current.address !== stored.address ||
      current.ownerCommitment !== stored.ownerCommitment ||
      current.expiresAt <= Date.now()
    ) {
      clearWalletSession();
      return null;
    }
    const validated = {
      ...stored,
      expiresAt: current.expiresAt,
    };
    storeWalletSession(validated);
    await ensureAccountEncryptionKey(validated);
    return validated;
  } catch {
    clearWalletSession();
    return null;
  }
}

export function clearWalletSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export async function signWalletTransaction(
  xdr: string,
  options: {
    address?: string;
    network?: string;
    networkPassphrase?: string;
  } = {},
): Promise<string> {
  const api = freighterApi();
  if (!api.signTransaction) {
    throw new Error("Freighter transaction signing is unavailable");
  }

  const signOptions = {
    accountToSign: options.address,
    address: options.address,
    network: options.network,
    networkPassphrase: options.networkPassphrase,
  };
  let result: unknown;
  try {
    result = await api.signTransaction(xdr, signOptions);
  } catch (error) {
    if (!options.networkPassphrase && !options.network && !options.address) throw error;
    result = await api.signTransaction(xdr);
  }

  const signedXdr = extractSignedXdr(result);
  if (!signedXdr) throw new Error("Freighter did not return a signed transaction xdr");
  return signedXdr;
}

function storeWalletSession(session: WalletSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

async function requestWalletAddress(): Promise<string> {
  const api = freighterApi();
  const access = api.requestAccess ? extractAddress(await api.requestAccess()) : undefined;
  if (access) return access;

  const address = api.getAddress ? extractAddress(await api.getAddress()) : undefined;
  if (address) return address;

  const publicKey = api.getPublicKey ? extractAddress(await api.getPublicKey()) : undefined;
  if (publicKey) return publicKey;

  throw new Error("Freighter did not return a Stellar address");
}

async function signChallenge(message: string): Promise<string> {
  const api = freighterApi();

  if (api.signMessage) {
    const signature = extractSignature(await api.signMessage(message));
    if (signature) return signature;
  }

  if (api.signBlob) {
    const payload = new TextEncoder().encode(message);
    const signature = extractSignature(await api.signBlob(payload));
    if (signature) return signature;
  }

  throw new Error("Freighter message signing is unavailable");
}

function freighterApi(): FreighterApi {
  if (typeof window === "undefined") {
    throw new Error("Wallet connection is only available in the browser");
  }
  const api = window.freighterApi ?? window.freighter;
  if (!api) throw new Error("Freighter wallet not found");
  return api;
}

function extractAddress(result: unknown): string | undefined {
  if (typeof result === "string") return normalizeAddress(result);
  if (!result || typeof result !== "object") return undefined;

  for (const key of ["address", "publicKey", "accountId"] as const) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "string") return normalizeAddress(value);
  }

  return undefined;
}

function extractSignature(result: unknown): string | undefined {
  if (result instanceof Uint8Array) return bytesToBase64(result);
  if (result instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(result));
  if (typeof result === "string") return normalizeSignature(result);
  if (!result || typeof result !== "object") return undefined;

  for (const key of ["signature", "signedMessage", "signedBlob", "result"] as const) {
    const value = (result as Record<string, unknown>)[key];
    if (value instanceof Uint8Array) return bytesToBase64(value);
    if (value instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(value));
    if (typeof value === "string") return normalizeSignature(value);
  }

  return undefined;
}

function extractSignedXdr(result: unknown): string | undefined {
  if (typeof result === "string") return normalizeXdr(result);
  if (!result || typeof result !== "object") return undefined;

  for (const key of ["signedTxXdr", "signedXDR", "signedTransaction", "xdr", "result"] as const) {
    const value = (result as Record<string, unknown>)[key];
    if (typeof value === "string") return normalizeXdr(value);
  }

  return undefined;
}

function normalizeAddress(value: string): string | undefined {
  const address = value.trim().toUpperCase();
  return /^G[A-Z2-7]{55}$/.test(address) ? address : undefined;
}

function normalizeSignature(value: string): string {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    return bytesToBase64(hexToBytes(trimmed.slice(2)));
  }
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return bytesToBase64(hexToBytes(trimmed));
  }
  return trimmed;
}

function normalizeXdr(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[A-Za-z0-9+/=]+$/.test(trimmed) ? trimmed : undefined;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return window.btoa(raw);
}
