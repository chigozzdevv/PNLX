import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import { ensureAccountEncryptionKey } from "@/lib/account-encryption";

const STORAGE_KEY = "pnlx.wallet.session";
const BACKUP_WARNING_KEY = "pnlx.private-note-backup.warning";
const FREIGHTER_DETECTION_TIMEOUT_MS = 3_000;
const FREIGHTER_APPROVAL_TIMEOUT_MS = 120_000;
let freighterApiPromise: Promise<typeof import("@stellar/freighter-api")> | undefined;

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

export async function connectWalletSession(): Promise<WalletSession> {
  const address = await requestWalletAddress();
  const challenge = await pnlxPost<AuthChallenge>("/auth/challenge", { address });
  const signature = await signChallenge(challenge.message, address);
  const session = await pnlxPost<AuthSessionResponse>("/auth/session", {
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
  await syncPrivateData(stored);
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
    const current = await pnlxGet<AuthSessionStatus>("/auth/session", stored.token);
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
    await syncPrivateData(validated);
    return validated;
  } catch {
    clearWalletSession();
    return null;
  }
}

export function clearWalletSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.sessionStorage.removeItem(BACKUP_WARNING_KEY);
}

export function privateNoteBackupWarning(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.sessionStorage.getItem(BACKUP_WARNING_KEY) ?? undefined;
}

export function clearPrivateNoteBackupWarning(): void {
  window.sessionStorage.removeItem(BACKUP_WARNING_KEY);
  window.dispatchEvent(new Event("pnlx:private-note-backup-status"));
}

export function setPrivateNoteBackupWarning(message: string): void {
  window.sessionStorage.setItem(BACKUP_WARNING_KEY, message);
  window.dispatchEvent(new Event("pnlx:private-note-backup-status"));
}

async function syncPrivateData(session: WalletSession): Promise<void> {
  try {
    await import("@/lib/private-note-backup").then(({ syncPrivateMarginNoteBackup }) =>
      syncPrivateMarginNoteBackup(session));
    clearPrivateNoteBackupWarning();
  } catch {
    setPrivateNoteBackupWarning("Private balance could not sync. Reconnect your wallet.");
  }
}

export async function signWalletTransaction(
  xdr: string,
  options: {
    address?: string;
    network?: string;
    networkPassphrase?: string;
  } = {},
): Promise<string> {
  const { signTransaction } = await loadFreighterApi();
  await assertFreighterConnected();
  const result = await withTimeout(
    signTransaction(xdr, {
      address: options.address,
      networkPassphrase: options.networkPassphrase,
    }),
    FREIGHTER_APPROVAL_TIMEOUT_MS,
    "Freighter signing timed out",
  );
  if (result.error) throw new Error(result.error.message);
  if (!result.signedTxXdr) throw new Error("Freighter did not return a signed transaction XDR");
  return result.signedTxXdr;
}

export async function signRecoveryMessage(message: string, address: string): Promise<string> {
  await assertFreighterConnected();
  return signChallenge(message, address);
}

function storeWalletSession(session: WalletSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

async function requestWalletAddress(): Promise<string> {
  const { requestAccess } = await loadFreighterApi();
  await assertFreighterConnected();
  const access = await withTimeout(
    requestAccess(),
    FREIGHTER_APPROVAL_TIMEOUT_MS,
    "Freighter approval timed out",
  );
  if (access.error) throw new Error(access.error.message);
  const address = normalizeAddress(access.address);
  if (address) return address;
  throw new Error("Freighter did not return a Stellar address");
}

async function signChallenge(message: string, address: string): Promise<string> {
  const { signMessage } = await loadFreighterApi();
  const result = await withTimeout(
    signMessage(message, { address }),
    FREIGHTER_APPROVAL_TIMEOUT_MS,
    "Freighter signing timed out",
  );
  if (result.error) throw new Error(result.error.message);
  const signature = extractSignature(result.signedMessage);
  if (signature) return signature;
  throw new Error("Freighter did not return a signed message");
}

async function assertFreighterConnected(): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("Wallet connection is only available in the browser");
  }

  const { isConnected } = await loadFreighterApi();
  const connected = await withTimeout(
    isConnected(),
    FREIGHTER_DETECTION_TIMEOUT_MS,
    "Open this page in a browser with Freighter installed",
  );
  if (connected.error) throw new Error(connected.error.message);
  if (!connected.isConnected) {
    throw new Error("Open this page in a browser with Freighter installed");
  }
}

function loadFreighterApi(): Promise<typeof import("@stellar/freighter-api")> {
  freighterApiPromise ??= import("@stellar/freighter-api");
  return freighterApiPromise;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
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
