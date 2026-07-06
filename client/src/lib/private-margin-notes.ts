import type { Hex } from "@/types/trading";

const STORAGE_KEY = "pnlx.private.margin-notes.v1";
const RUNTIME_SCOPE_KEY = "pnlx.private.margin-notes.runtime-scope.v1";

export type PrivateMarginNoteStatus = "available" | "locked" | "pending" | "spent";
type ReconciledOrderStatus = "open" | "filled" | "partially-filled" | "cancelled";

let activeRuntimeScope: string | undefined;

export interface PrivateMarginNoteRuntimeHealth {
  custody?: {
    collateralAsset?: {
      tokenContract?: string;
      tokenDigest?: Hex;
    };
  };
  persistence?: {
    mongodb?: {
      collection?: string;
      database?: string;
    };
  };
  runtime?: {
    clientStorageScope?: string;
  };
  stellar?: {
    network?: string;
  };
}

export interface StoredPrivateMarginNote {
  amount: string;
  assetDigest: Hex;
  blinding: Hex;
  commitment: Hex;
  createdAt: number;
  noteNullifier: Hex;
  ownerCommitment: Hex;
  ownerDigest: Hex;
  rhoDigest: Hex;
  spendSecretDigest: Hex;
  status: PrivateMarginNoteStatus;
  updatedAt: number;
  walletAddress: string;
  lockedByIntentCommitment?: Hex;
  runtimeScope?: string;
}

export function privateSpendableBalance(ownerCommitment?: Hex): bigint {
  return privateMarginNotes(ownerCommitment)
    .filter((note) => note.status === "available")
    .reduce((total, note) => total + BigInt(note.amount), 0n);
}

export function privateReservedBalance(ownerCommitment?: Hex): bigint {
  const notes = privateMarginNotes(ownerCommitment);
  const pendingChangeByIntent = new Map<Hex, bigint>();
  for (const note of notes) {
    if (note.status !== "pending" || !note.lockedByIntentCommitment) continue;
    pendingChangeByIntent.set(
      note.lockedByIntentCommitment,
      (pendingChangeByIntent.get(note.lockedByIntentCommitment) ?? 0n) + BigInt(note.amount),
    );
  }

  return notes
    .filter((note) => note.status === "locked")
    .reduce((total, note) => {
      const amount = BigInt(note.amount);
      const pendingChange = note.lockedByIntentCommitment
        ? (pendingChangeByIntent.get(note.lockedByIntentCommitment) ?? 0n)
        : 0n;
      const reserved = amount > pendingChange ? amount - pendingChange : 0n;
      return total + reserved;
    }, 0n);
}

export function privatePendingBalance(ownerCommitment?: Hex): bigint {
  return privateMarginNotes(ownerCommitment)
    .filter((note) => note.status === "pending")
    .reduce((total, note) => total + BigInt(note.amount), 0n);
}

export function privateMarginNotes(ownerCommitment?: Hex): StoredPrivateMarginNote[] {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) return [];
  return readPrivateMarginNotes()
    .filter((note) => note.runtimeScope === scope)
    .filter((note) => !ownerCommitment || note.ownerCommitment === ownerCommitment);
}

export function setPrivateMarginNoteRuntimeScope(scope?: string): void {
  if (typeof window === "undefined") {
    activeRuntimeScope = normalizeRuntimeScope(scope);
    return;
  }
  const normalized = normalizeRuntimeScope(scope);
  activeRuntimeScope = normalized;
  if (normalized) {
    window.sessionStorage.setItem(RUNTIME_SCOPE_KEY, normalized);
  } else {
    window.sessionStorage.removeItem(RUNTIME_SCOPE_KEY);
  }
}

export function currentPrivateMarginNoteRuntimeScope(): string | undefined {
  if (activeRuntimeScope) return activeRuntimeScope;
  if (typeof window === "undefined") return undefined;
  activeRuntimeScope = normalizeRuntimeScope(window.sessionStorage.getItem(RUNTIME_SCOPE_KEY) ?? undefined);
  return activeRuntimeScope;
}

export function privateMarginNoteRuntimeScopeFromHealth(
  health: PrivateMarginNoteRuntimeHealth,
): string | undefined {
  const serverScope = normalizeRuntimeScope(health.runtime?.clientStorageScope);
  if (serverScope) return serverScope;

  return normalizeRuntimeScope([
    "pnlx",
    health.stellar?.network,
    health.persistence?.mongodb?.database,
    health.persistence?.mongodb?.collection,
    health.custody?.collateralAsset?.tokenContract,
  ].filter(Boolean).join(":"));
}

function readPrivateMarginNotes(): StoredPrivateMarginNote[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown[];
    return parsed
      .map(normalizeNote)
      .filter((note): note is StoredPrivateMarginNote => Boolean(note));
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

export function savePrivateMarginNote(
  input: Omit<StoredPrivateMarginNote, "createdAt" | "status" | "updatedAt"> &
    Partial<Pick<StoredPrivateMarginNote, "createdAt" | "status" | "updatedAt">>,
): StoredPrivateMarginNote {
  const now = Date.now();
  const note: StoredPrivateMarginNote = {
    ...input,
    createdAt: input.createdAt ?? now,
    runtimeScope: input.runtimeScope ?? currentPrivateMarginNoteRuntimeScope(),
    status: input.status ?? "available",
    updatedAt: input.updatedAt ?? now,
  };
  writeNotes([
    note,
    ...readPrivateMarginNotes().filter((existing) => existing.commitment !== note.commitment),
  ]);
  return note;
}

export function selectPrivateMarginNote(input: {
  amount: bigint;
  assetDigest?: Hex;
  excludedCommitments?: Iterable<Hex>;
  ownerCommitment: Hex;
}): StoredPrivateMarginNote {
  const excludedCommitments = new Set(input.excludedCommitments ?? []);
  const candidates = privateMarginNotes(input.ownerCommitment)
    .filter((note) => note.status === "available")
    .filter((note) => !excludedCommitments.has(note.commitment))
    .filter((note) => !input.assetDigest || note.assetDigest === input.assetDigest)
    .sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)));
  const sufficient = candidates.find((note) => BigInt(note.amount) >= input.amount);
  if (sufficient) return sufficient;

  throw new Error("Deposit private USDC before trading");
}

export function selectWithdrawablePrivateMarginNote(input: {
  assetDigest?: Hex;
  ownerCommitment: Hex;
}): StoredPrivateMarginNote {
  const candidates = privateMarginNotes(input.ownerCommitment)
    .filter((note) => note.status === "available")
    .filter((note) => !input.assetDigest || note.assetDigest === input.assetDigest)
    .sort((a, b) => Number(BigInt(b.amount) - BigInt(a.amount)));
  const note = candidates[0];
  if (note) return note;

  throw new Error("No available collateral to withdraw");
}

export function lockPrivateMarginNote(commitment: Hex, intentCommitment: Hex): void {
  writeNotes(
    readPrivateMarginNotes().map((note) =>
      note.commitment === commitment
        ? {
            ...note,
            lockedByIntentCommitment: intentCommitment,
            status: "locked",
            updatedAt: Date.now(),
          }
        : note,
    ),
  );
}

export function markPrivateMarginNoteSpent(commitment: Hex): void {
  writeNotes(
    readPrivateMarginNotes().map((note) =>
      note.commitment === commitment
        ? {
            ...note,
            status: "spent" as const,
            updatedAt: Date.now(),
          }
        : note,
    ),
  );
}

export function savePendingPrivateMarginChange(
  input: Omit<StoredPrivateMarginNote, "createdAt" | "status" | "updatedAt">,
): StoredPrivateMarginNote {
  return savePrivateMarginNote({
    ...input,
    status: "pending",
  });
}

export function reconcilePrivateMarginNotes(input: {
  orders: Array<{
    intentCommitment: Hex;
    status: ReconciledOrderStatus;
  }>;
}): void {
  const orderStatus = new Map(input.orders.map((order) => [order.intentCommitment, order.status]));
  let changed = false;
  const next = readPrivateMarginNotes().map((note) => {
    if (!note.lockedByIntentCommitment) return note;
    const status = orderStatus.get(note.lockedByIntentCommitment);
    if (!status) return note;

    if (status === "filled" || status === "partially-filled") {
      if (note.status === "locked") {
        changed = true;
        return {
          ...note,
          status: "spent" as const,
          updatedAt: Date.now(),
        };
      }
      if (note.status === "pending") {
        changed = true;
        return {
          ...note,
          lockedByIntentCommitment: undefined,
          status: "available" as const,
          updatedAt: Date.now(),
        };
      }
    }

    if (status === "cancelled") {
      if (note.status === "locked") {
        changed = true;
        return {
          ...note,
          lockedByIntentCommitment: undefined,
          status: "available" as const,
          updatedAt: Date.now(),
        };
      }
      if (note.status === "pending") {
        changed = true;
        return {
          ...note,
          status: "spent" as const,
          updatedAt: Date.now(),
        };
      }
    }

    return note;
  });
  if (changed) writeNotes(next);
}

function writeNotes(notes: StoredPrivateMarginNote[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  window.dispatchEvent(new Event("pnlx:private-margin-notes"));
}

function normalizeNote(value: unknown): StoredPrivateMarginNote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const note = value as Partial<StoredPrivateMarginNote>;
  if (
    !note.amount ||
    !note.assetDigest ||
    !note.blinding ||
    !note.commitment ||
    !note.noteNullifier ||
    !note.ownerCommitment ||
    !note.ownerDigest ||
    !note.rhoDigest ||
    !note.spendSecretDigest ||
    !note.walletAddress
  ) {
    return undefined;
  }
  return {
    amount: String(note.amount),
    assetDigest: note.assetDigest,
    blinding: note.blinding,
    commitment: note.commitment,
    createdAt: Number(note.createdAt ?? Date.now()),
    lockedByIntentCommitment: note.lockedByIntentCommitment,
    noteNullifier: note.noteNullifier,
    ownerCommitment: note.ownerCommitment,
    ownerDigest: note.ownerDigest,
    rhoDigest: note.rhoDigest,
    runtimeScope: normalizeRuntimeScope(note.runtimeScope),
    spendSecretDigest: note.spendSecretDigest,
    status: normalizeStatus(note.status),
    updatedAt: Number(note.updatedAt ?? Date.now()),
    walletAddress: note.walletAddress,
  };
}

function normalizeStatus(value: unknown): PrivateMarginNoteStatus {
  return value === "locked" || value === "pending" || value === "spent" ? value : "available";
}

function normalizeRuntimeScope(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}
