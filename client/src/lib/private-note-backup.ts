import { createCircuitMarginCommitment, fieldHashPair } from "@/lib/private-note";
import type { PrivateAccountEventPayload } from "@/lib/account-encryption";
import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import {
  currentPrivateMarginNoteRuntimeScope,
  hasLocallyStoredPrivateMarginNotes,
  privateMarginNotes,
  privateMarginNoteRuntimeScopeFromHealth,
  savePrivateMarginNote,
  setPrivateMarginNoteRuntimeScope,
  type PrivateMarginNoteRuntimeHealth,
  type StoredPrivateMarginNote,
} from "@/lib/private-margin-notes";
import { signRecoveryMessage, type WalletSession } from "@/lib/wallet-auth";
import type { Hex } from "@/types/trading";

const PREFIX = "pnlx-note-backup-v1:";
const OPENING_PREFIX = "pnlx-opening-backup-v1:";
const keys = new Map<string, CryptoKey>();
const unlocking = new Map<string, Promise<void>>();
const backedUp = new Set<string>();
const backedUpOpenings = new Set<string>();
const openingBackupsInFlight = new Map<string, Promise<void>>();
const DB_NAME = "pnlx-private-note-recovery";
const KEY_STORE = "keys";

interface BackupRecord { commitment: Hex; ciphertext: string }
interface NoteStatus { commitment: Hex; known: boolean; spent: boolean; activeIntentCommitment?: Hex }

async function fetchBackups(path: string, scope: string, session: WalletSession): Promise<BackupRecord[]> {
  const backups: BackupRecord[] = [];
  let cursor: Hex | undefined;
  do {
    const params = new URLSearchParams({ scope });
    if (cursor) params.set("cursor", cursor);
    const page: { backups: BackupRecord[]; nextCursor?: Hex } = await pnlxGet(
      `${path}?${params.toString()}`,
      session.token,
    );
    backups.push(...page.backups);
    if (page.nextCursor && (page.nextCursor === cursor || page.backups.length === 0)) {
      throw new Error("Invalid private backup page");
    }
    cursor = page.nextCursor;
  } while (cursor);
  return backups;
}

export async function unlockPrivateNoteBackup(session: WalletSession): Promise<void> {
  const scope = requiredScope();
  const id = `${session.ownerCommitment}:${scope}`;
  if (keys.has(id)) return;
  const pending = unlocking.get(id);
  if (pending) return pending;
  const operation = unlockPrivateNoteBackupKey(session, scope, id);
  unlocking.set(id, operation);
  try {
    await operation;
  } finally {
    unlocking.delete(id);
  }
}

async function unlockPrivateNoteBackupKey(session: WalletSession, scope: string, id: string): Promise<void> {
  const stored = await getStoredKey(id);
  if (stored) {
    keys.set(id, stored);
    return;
  }
  const message = [
    "PNLX private note recovery",
    "Approve to unlock your encrypted private balance on this device.",
    "This message does not authorize a transaction.",
    `Wallet: ${session.address}`,
    `Scope: ${scope}`,
    "Version: 1",
  ].join("\n");
  const signature = await signRecoveryMessage(message, session.address);
  const signatureBytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
  if (signatureBytes.length !== 64) throw new Error("Wallet returned an invalid recovery signature");
  const material = new Uint8Array([
    ...new TextEncoder().encode("pnlx-private-note-backup-v1"),
    ...signatureBytes,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", material);
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  await putStoredKey(id, key);
  keys.set(id, key);
}

export function clearPrivateNoteBackupKey(): void {
  keys.clear();
  unlocking.clear();
}

export async function backUpPrivateMarginNote(
  note: StoredPrivateMarginNote,
  session: WalletSession,
): Promise<void> {
  const scope = requiredScope();
  if (note.ownerCommitment.toLowerCase() !== session.ownerCommitment.toLowerCase() ||
      note.walletAddress.toUpperCase() !== session.address.toUpperCase()) {
    throw new Error("Private note does not belong to the connected wallet");
  }
  await unlockPrivateNoteBackup(session);
  const key = keys.get(`${session.ownerCommitment}:${scope}`)!;
  const ciphertext = await encryptNoteBackup(key, session.ownerCommitment, scope, note);
  const response = await pnlxPost<{ ciphertext: string }>("/notes/backup", {
    scope,
    commitment: note.commitment,
    ciphertext,
  }, session.token);
  const verified = await decryptNoteBackup(key, session.ownerCommitment, scope, {
    commitment: note.commitment, ciphertext: response.ciphertext,
  });
  if (verified.blinding !== note.blinding || verified.rhoDigest !== note.rhoDigest ||
      verified.spendSecretDigest !== note.spendSecretDigest || verified.amount !== note.amount) {
    throw new Error("Saved private balance does not match this browser");
  }
  backedUp.add(`${session.ownerCommitment}:${scope}:${note.commitment.toLowerCase()}`);
}

type OpeningPayload = Extract<PrivateAccountEventPayload, { kind: "position-opening" }>;

export async function backUpPrivateOpening(session: WalletSession, payload: OpeningPayload): Promise<void> {
  const scope = requiredScope();
  const commitment = payload.opening.positionCommitment;
  const id = `${session.ownerCommitment}:${scope}:${commitment.toLowerCase()}`;
  if (backedUpOpenings.has(id)) return;
  const inFlight = openingBackupsInFlight.get(id);
  if (inFlight) return inFlight;
  const operation = (async () => {
    await unlockPrivateNoteBackup(session);
    const key = keys.get(`${session.ownerCommitment}:${scope}`)!;
    const ciphertext = await encryptOpeningBackup(key, session.ownerCommitment, scope, payload);
    const response = await pnlxPost<{ ciphertext: string }>("/positions/backup", { scope, commitment, ciphertext }, session.token);
    const verified = await decryptOpeningBackup(key, session.ownerCommitment, scope, { commitment, ciphertext: response.ciphertext });
    if (JSON.stringify(verified) !== JSON.stringify(payload)) throw new Error("Saved position backup does not match this browser");
    backedUpOpenings.add(id);
  })();
  openingBackupsInFlight.set(id, operation);
  try {
    await operation;
  } finally {
    openingBackupsInFlight.delete(id);
  }
}

export async function restorePrivateOpenings(session: WalletSession, commitments: Hex[]): Promise<OpeningPayload[]> {
  if (!commitments.length) return [];
  const scope = requiredScope();
  const wanted = new Set(commitments.map((commitment) => commitment.toLowerCase()));
  const backups = (await fetchBackups("/positions/backups", scope, session))
    .filter((backup) => wanted.has(backup.commitment.toLowerCase()));
  if (!backups.length) return [];
  await unlockPrivateNoteBackup(session);
  const key = keys.get(`${session.ownerCommitment}:${scope}`)!;
  const payloads: OpeningPayload[] = [];
  for (const backup of backups) {
    const payload = await decryptOpeningBackup(key, session.ownerCommitment, scope, backup);
    payloads.push(payload);
  }
  return payloads;
}

export async function encryptOpeningBackup(
  key: CryptoKey, owner: Hex, scope: string, payload: OpeningPayload,
): Promise<string> {
  return encryptPayload(key, owner, scope, payload.opening.positionCommitment, payload, OPENING_PREFIX);
}

export async function decryptOpeningBackup(
  key: CryptoKey, owner: Hex, scope: string, backup: BackupRecord,
): Promise<OpeningPayload> {
  const payload = await decryptPayload<OpeningPayload>(
    key, owner, scope, backup.commitment, backup.ciphertext, OPENING_PREFIX,
  );
  if (payload.kind !== "position-opening" || payload.opening.positionCommitment.toLowerCase() !== backup.commitment.toLowerCase()) {
    throw new Error("Encrypted position backup does not match its commitment");
  }
  return payload;
}

export async function restorePrivateMarginNotes(session: WalletSession): Promise<number> {
  const scope = requiredScope();
  const backups = await fetchBackups("/notes/backups", scope, session);
  const existing = new Set(privateMarginNotes(session.ownerCommitment).map((note) => note.commitment.toLowerCase()));
  const missing = backups.filter((backup) => !existing.has(backup.commitment.toLowerCase()));
  if (!missing.length) return 0;
  await unlockPrivateNoteBackup(session);
  const key = keys.get(`${session.ownerCommitment}:${scope}`)!;
  const restored: StoredPrivateMarginNote[] = [];
  for (const backup of missing) {
    const note = await decryptNoteBackup(key, session.ownerCommitment, scope, backup);
    restored.push(note);
  }
  const byCommitment = new Map<string, NoteStatus>();
  for (let index = 0; index < restored.length; index += 16) {
    const status = await pnlxPost<{ notes: NoteStatus[] }>("/notes/recovery-status", {
      notes: restored.slice(index, index + 16).map((note) => ({ commitment: note.commitment, nullifier: note.noteNullifier })),
    }, session.token);
    for (const item of status.notes) byCommitment.set(item.commitment.toLowerCase(), item);
  }
  let count = 0;
  for (const note of restored) {
    const current = byCommitment.get(note.commitment.toLowerCase());
    if (!current?.known || current.spent || existing.has(note.commitment.toLowerCase())) continue;
    savePrivateMarginNote({
      ...note,
      status: current.activeIntentCommitment ? "locked" : "available",
      lockedByIntentCommitment: current.activeIntentCommitment,
    });
    count += 1;
    backedUp.add(`${session.ownerCommitment}:${scope}:${note.commitment.toLowerCase()}`);
  }
  return count;
}

export async function backUpExistingPrivateMarginNotes(session: WalletSession): Promise<number> {
  const notes = privateMarginNotes(session.ownerCommitment).filter((note) => note.status !== "spent");
  if (!notes.length) return 0;
  await unlockPrivateNoteBackup(session);
  for (const note of notes) {
    if (backedUp.has(`${session.ownerCommitment}:${note.runtimeScope}:${note.commitment.toLowerCase()}`)) continue;
    await backUpPrivateMarginNote(note, session);
  }
  return notes.length;
}

export async function syncPrivateMarginNoteBackup(session: WalletSession): Promise<number> {
  const health = await pnlxGet<PrivateMarginNoteRuntimeHealth>("/health", session.token);
  const scope = privateMarginNoteRuntimeScopeFromHealth(health);
  setPrivateMarginNoteRuntimeScope(scope);
  await migrateLocalPrivateMarginNotes(session, scope);
  return restorePrivateMarginNotes(session);
}

async function migrateLocalPrivateMarginNotes(session: WalletSession, scope?: string): Promise<void> {
  if (!hasLocallyStoredPrivateMarginNotes(session.ownerCommitment)) return;
  if (!scope) return;
  const marker = `pnlx.private-note-backup.migrated:${session.ownerCommitment}:${scope}`;
  if (window.localStorage.getItem(marker) === "1" || privateMarginNotes(session.ownerCommitment).length === 0) return;
  await backUpExistingPrivateMarginNotes(session);
  window.localStorage.setItem(marker, "1");
}

export async function encryptNoteBackup(
  key: CryptoKey,
  owner: Hex,
  scope: string,
  note: StoredPrivateMarginNote,
): Promise<string> {
  return encryptPayload(key, owner, scope, note.commitment, { ...note, runtimeScope: scope }, PREFIX);
}

async function encryptPayload(
  key: CryptoKey, owner: Hex, scope: string, commitment: Hex, payload: unknown, prefix: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesBuffer(iv), additionalData: bytesBuffer(associatedData(owner, scope, commitment)) },
    key,
    plaintext,
  );
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return prefix + toBase64Url(packed);
}

export async function decryptNoteBackup(
  key: CryptoKey,
  owner: Hex,
  scope: string,
  backup: BackupRecord,
): Promise<StoredPrivateMarginNote> {
  const note = await decryptPayload<StoredPrivateMarginNote>(
    key, owner, scope, backup.commitment, backup.ciphertext, PREFIX,
  );
  if (note.runtimeScope !== scope || note.ownerCommitment.toLowerCase() !== owner.toLowerCase() ||
      note.commitment.toLowerCase() !== backup.commitment.toLowerCase() || !/^\d+$/.test(note.amount)) {
    throw new Error("Private note backup does not match this account");
  }
  const commitment = createCircuitMarginCommitment({
    amount: BigInt(note.amount), assetDigest: note.assetDigest, blinding: note.blinding,
    ownerDigest: note.ownerDigest, rhoDigest: note.rhoDigest, spendSecretDigest: note.spendSecretDigest,
  });
  if (commitment.toLowerCase() !== note.commitment.toLowerCase() ||
      fieldHashPair(note.spendSecretDigest, note.rhoDigest).toLowerCase() !== note.noteNullifier.toLowerCase()) {
    throw new Error("Private note backup failed integrity checks");
  }
  return note;
}

async function decryptPayload<T>(
  key: CryptoKey, owner: Hex, scope: string, commitment: Hex, ciphertext: string, prefix: string,
): Promise<T> {
  if (!ciphertext.startsWith(prefix)) throw new Error("Unsupported private backup");
  const packed = fromBase64Url(ciphertext.slice(prefix.length));
  if (packed.length < 29) throw new Error("Corrupt private note backup");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesBuffer(packed.slice(0, 12)), additionalData: bytesBuffer(associatedData(owner, scope, commitment)) },
      key,
      packed.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new Error("Unable to unlock private data. Use the same wallet and recovery signature.");
  }
}

function requiredScope(): string {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Private balance network is unavailable");
  return scope;
}

function associatedData(owner: Hex, scope: string, commitment: Hex): Uint8Array {
  return new TextEncoder().encode(`${owner.toLowerCase()}:${scope}:${commitment.toLowerCase()}`);
}

function toBase64Url(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), (char) => char.charCodeAt(0));
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function getStoredKey(id: string): Promise<CryptoKey | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const db = await openRecoveryDb();
  try {
    return await requestResult<CryptoKey | undefined>(db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(id));
  } finally {
    db.close();
  }
}

async function putStoredKey(id: string, key: CryptoKey): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openRecoveryDb();
  try {
    await requestResult(db.transaction(KEY_STORE, "readwrite").objectStore(KEY_STORE).put(key, id));
  } finally {
    db.close();
  }
}

function openRecoveryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
