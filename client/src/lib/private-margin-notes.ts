import type { Hex } from "@/types/trading";

const STORAGE_KEY = "pnlx.private.margin-notes.v1";
const RUNTIME_SCOPE_KEY = "pnlx.private.margin-notes.runtime-scope.v1";

export type PrivateMarginNoteStatus = "available" | "locked" | "pending" | "spent";
type ReconciledOrderStatus = "open" | "filled" | "partially-filled" | "cancelled";

export interface ReconciledPrivateMarginOrder {
  intentCommitment: Hex;
  noteNullifier?: Hex;
  sourceIntentCommitment?: Hex;
  status: ReconciledOrderStatus;
}

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

export interface PrivateMarginNoteAllocation {
  amount: bigint;
  note: StoredPrivateMarginNote;
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
  const allocation = planPrivateMarginNoteAllocations(input)[0];
  if (allocation) return allocation.note;

  throw new Error("Deposit private USDC before trading");
}

export function planPrivateMarginNoteAllocations(input: {
  amount: bigint;
  assetDigest?: Hex;
  excludedCommitments?: Iterable<Hex>;
  notes?: StoredPrivateMarginNote[];
  ownerCommitment: Hex;
}): PrivateMarginNoteAllocation[] {
  if (input.amount <= 0n) throw new Error("Private margin must be positive");
  const excludedCommitments = new Set(input.excludedCommitments ?? []);
  const candidates = (input.notes ?? privateMarginNotes(input.ownerCommitment))
    .filter((note) => note.ownerCommitment === input.ownerCommitment)
    .filter((note) => note.status === "available")
    .filter((note) => !excludedCommitments.has(note.commitment))
    .filter((note) => !input.assetDigest || note.assetDigest === input.assetDigest)
    .sort((left, right) => compareBigInt(BigInt(left.amount), BigInt(right.amount)));
  const sufficient = candidates.find((note) => BigInt(note.amount) >= input.amount);
  if (sufficient) return [{ amount: input.amount, note: sufficient }];

  const total = candidates.reduce((sum, note) => sum + BigInt(note.amount), 0n);
  if (total < input.amount) throw new Error("Deposit private USDC before trading");

  let remaining = input.amount;
  const allocations: PrivateMarginNoteAllocation[] = [];
  for (const note of [...candidates].reverse()) {
    if (remaining === 0n) break;
    const noteAmount = BigInt(note.amount);
    const amount = noteAmount < remaining ? noteAmount : remaining;
    if (amount <= 0n) continue;
    allocations.push({ amount, note });
    remaining -= amount;
  }
  if (remaining !== 0n) throw new Error("Deposit private USDC before trading");
  return allocations;
}

export function selectWithdrawablePrivateMarginNote(input: {
  assetDigest?: Hex;
  commitment?: Hex;
  ownerCommitment: Hex;
}): StoredPrivateMarginNote {
  const candidates = privateMarginNotes(input.ownerCommitment)
    .filter((note) => note.status === "available")
    .filter((note) => !input.assetDigest || note.assetDigest === input.assetDigest)
    .filter((note) => !input.commitment || note.commitment === input.commitment)
    .sort((left, right) => compareBigInt(BigInt(right.amount), BigInt(left.amount)));
  const note = candidates[0];
  if (note) return note;

  throw new Error(input.commitment ? "Selected private note is unavailable" : "No available collateral to withdraw");
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
  orders: ReconciledPrivateMarginOrder[];
}): void {
  const notes = readPrivateMarginNotes();
  const orderStatus = reconciledOrderStatuses(input.orders, notes);
  let changed = false;
  const next = notes.map((note) => {
    if (!note.lockedByIntentCommitment) return note;
    const status = orderStatus.get(intentCommitmentKey(note.lockedByIntentCommitment));
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

function reconciledOrderStatuses(
  orders: ReconciledPrivateMarginOrder[],
  notes: StoredPrivateMarginNote[],
): Map<string, ReconciledOrderStatus> {
  const statuses = new Map<string, ReconciledOrderStatus>();
  const statusesByNullifier = new Map<string, Set<ReconciledOrderStatus>>();
  for (const order of orders) {
    setReconciledOrderStatus(statuses, order.intentCommitment, order.status);
    if (order.noteNullifier) {
      const key = noteNullifierKey(order.noteNullifier);
      const values = statusesByNullifier.get(key) ?? new Set<ReconciledOrderStatus>();
      values.add(order.status);
      statusesByNullifier.set(key, values);
    }

    // A residual exists only after its source intent has settled a partial fill.
    // The source note must therefore be consumed and its pre-submission change
    // released, even when the cancellation response names only the residual.
    if (
      order.sourceIntentCommitment &&
      intentCommitmentKey(order.sourceIntentCommitment) !== intentCommitmentKey(order.intentCommitment)
    ) {
      setReconciledOrderStatus(statuses, order.sourceIntentCommitment, "partially-filled");
    }
  }

  // Fall back to a note nullifier only when its stored intent is absent; exact active intents always win.
  for (const note of notes) {
    if (note.status !== "locked" || !note.lockedByIntentCommitment) continue;
    const intentKey = intentCommitmentKey(note.lockedByIntentCommitment);
    if (statuses.has(intentKey)) continue;
    const status = fallbackStatusForNullifier(statusesByNullifier.get(noteNullifierKey(note.noteNullifier)));
    if (status) setReconciledOrderStatus(statuses, note.lockedByIntentCommitment, status);
  }
  return statuses;
}

function fallbackStatusForNullifier(
  statuses: Set<ReconciledOrderStatus> | undefined,
): ReconciledOrderStatus | undefined {
  if (!statuses || statuses.size === 0) return undefined;

  // `partially-filled` remains matcher-active. Keep the note locked unless
  // the exact source intent is present above and can be reconciled directly.
  if (statuses.has("open") || statuses.has("partially-filled")) return "open";
  if (statuses.has("filled")) return "filled";
  if (statuses.has("cancelled")) return "cancelled";
  return undefined;
}

function setReconciledOrderStatus(
  statuses: Map<string, ReconciledOrderStatus>,
  intentCommitment: Hex,
  status: ReconciledOrderStatus,
): void {
  const key = intentCommitmentKey(intentCommitment);
  const current = statuses.get(key);
  if (!current || reconciliationStatusPriority(status) >= reconciliationStatusPriority(current)) {
    statuses.set(key, status);
  }
}

function reconciliationStatusPriority(status: ReconciledOrderStatus): number {
  switch (status) {
    case "cancelled":
    case "filled":
      return 3;
    case "partially-filled":
      return 2;
    case "open":
      return 1;
  }
}

function intentCommitmentKey(intentCommitment: Hex): string {
  return intentCommitment.toLowerCase();
}

function noteNullifierKey(noteNullifier: Hex): string {
  return noteNullifier.toLowerCase();
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

function compareBigInt(left: bigint, right: bigint): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
