import type { Hex } from "@/types/trading";

const STORAGE_KEY = "pnlx.private.margin-notes.v1";
const RUNTIME_SCOPE_KEY = "pnlx.private.margin-notes.runtime-scope.v1";

export type PrivateMarginNoteStatus = "available" | "locked" | "pending" | "claiming" | "spent";
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
  noteFormat?: "secure";
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
  /** A prepared/submitted intent owns this reservation until exact lifecycle evidence resolves it. */
  submissionPending?: boolean;
  /** Cleared durably before any intent submission can leave this device. */
  preparationOnly?: boolean;
  updatedAt: number;
  walletAddress: string;
  lockedByIntentCommitment?: Hex;
  claimSourceIntentCommitment?: Hex;
  runtimeScope?: string;
}

export interface PrivateMarginNoteAllocation {
  amount: bigint;
  note: StoredPrivateMarginNote;
}

export interface PrivateMarginRepairCandidate {
  changeAmount: bigint;
  changeCommitment: Hex;
  intentCommitment: Hex;
  sourceAmount: bigint;
  sourceCommitment: Hex;
}

export interface PrivateMarginRepairEligibility {
  hasActiveOrders: boolean;
  hasCancelledOrder: boolean;
  hasOpenPositions: boolean;
  ownerCommitment: Hex;
}

export function privateSpendableBalance(ownerCommitment?: Hex): bigint {
  return privateMarginNotes(ownerCommitment)
    .filter((note) => note.status === "available")
    .reduce((total, note) => total + BigInt(note.amount), 0n);
}

export function privateReservedBalance(ownerCommitment?: Hex): bigint {
  const notes = privateMarginNotes(ownerCommitment);
  const pendingChangeByIntent = new Map<string, bigint>();
  for (const note of notes) {
    if (note.status !== "pending" || !note.lockedByIntentCommitment) continue;
    const key = intentCommitmentKey(note.lockedByIntentCommitment);
    pendingChangeByIntent.set(
      key,
      (pendingChangeByIntent.get(key) ?? 0n) + BigInt(note.amount),
    );
  }

  return notes
    .filter((note) => note.status === "locked")
    .reduce((total, note) => {
      const amount = BigInt(note.amount);
      const pendingChange = note.lockedByIntentCommitment
        ? (pendingChangeByIntent.get(intentCommitmentKey(note.lockedByIntentCommitment)) ?? 0n)
        : 0n;
      const reserved = amount > pendingChange ? amount - pendingChange : 0n;
      return total + reserved;
    }, 0n);
}

export function privatePendingBalance(ownerCommitment?: Hex): bigint {
  return privateMarginNotes(ownerCommitment)
    .filter((note) => note.status === "pending" || note.status === "claiming")
    .reduce((total, note) => total + BigInt(note.amount), 0n);
}

export function findPrivateMarginRepairCandidate(
  input: PrivateMarginRepairEligibility,
): PrivateMarginRepairCandidate | undefined {
  if (input.hasActiveOrders || input.hasOpenPositions || !input.hasCancelledOrder) return undefined;

  const notes = privateMarginNotes(input.ownerCommitment);
  const sources = notes.filter((note) => note.status === "locked" && !note.submissionPending && Boolean(note.lockedByIntentCommitment));
  const changes = notes.filter((note) => note.status === "pending" && Boolean(note.lockedByIntentCommitment));
  if (sources.length !== 1 || changes.length !== 1) return undefined;

  const source = sources[0];
  const change = changes[0];
  if (!sameHex(source.assetDigest, change.assetDigest)) return undefined;
  const intentCommitment = source.lockedByIntentCommitment;
  if (!intentCommitment || !change.lockedByIntentCommitment) return undefined;
  if (source.commitment === change.commitment) return undefined;
  if (intentCommitmentKey(intentCommitment) !== intentCommitmentKey(change.lockedByIntentCommitment)) {
    return undefined;
  }

  const sourceAmount = BigInt(source.amount);
  const changeAmount = BigInt(change.amount);
  if (sourceAmount <= 0n || changeAmount <= 0n || changeAmount > sourceAmount) return undefined;

  return {
    changeAmount,
    changeCommitment: change.commitment,
    intentCommitment,
    sourceAmount,
    sourceCommitment: source.commitment,
  };
}

export function repairPrivateMarginNotes(candidate: PrivateMarginRepairCandidate): boolean {
  const notes = readPrivateMarginNotes();
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) return false;
  const source = notes.find((note) => isCurrentNote(note, scope) && sameHex(note.commitment, candidate.sourceCommitment));
  const change = notes.find((note) => isCurrentNote(note, scope) && sameHex(note.commitment, candidate.changeCommitment));
  if (
    !source ||
    !change ||
    !sameHex(source.ownerCommitment, change.ownerCommitment) ||
    !sameHex(source.assetDigest, change.assetDigest) ||
    BigInt(source.amount) !== candidate.sourceAmount ||
    BigInt(change.amount) !== candidate.changeAmount ||
    source.status !== "locked" ||
    source.submissionPending ||
    change.status !== "pending" ||
    !source.lockedByIntentCommitment ||
    !change.lockedByIntentCommitment ||
    intentCommitmentKey(source.lockedByIntentCommitment) !== intentCommitmentKey(candidate.intentCommitment) ||
    intentCommitmentKey(change.lockedByIntentCommitment) !== intentCommitmentKey(candidate.intentCommitment)
  ) {
    return false;
  }

  const now = Date.now();
  writeNotes(notes.map((note) => {
    if (note === source) {
      return {
        ...note,
        lockedByIntentCommitment: undefined,
        status: "available" as const,
        updatedAt: now,
      };
    }
    if (note === change) {
      return {
        ...note,
        status: "spent" as const,
        updatedAt: now,
      };
    }
    return note;
  }));
  return true;
}

export function privateMarginNotes(ownerCommitment?: Hex): StoredPrivateMarginNote[] {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) return [];
  return readPrivateMarginNotes()
    .filter((note) => note.runtimeScope === scope)
    .filter((note) => note.noteFormat === "secure")
    .filter((note) => !ownerCommitment || sameHex(note.ownerCommitment, ownerCommitment));
}

export function hasLocallyStoredPrivateMarginNotes(ownerCommitment: Hex): boolean {
  return readPrivateMarginNotes().some((note) =>
    note.noteFormat === "secure" &&
    note.ownerCommitment.toLowerCase() === ownerCommitment.toLowerCase() && note.status !== "spent");
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
  if (!health.stellar?.network || !health.custody?.collateralAsset?.tokenContract) return undefined;

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
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Private note storage is not a list");
    return parsed
      .map(normalizeNote)
      .filter((note): note is StoredPrivateMarginNote => Boolean(note));
  } catch (cause) {
    throw new Error("Private note storage is unreadable. Preserve this browser's data and restore its encrypted backup before continuing.", { cause });
  }
}

export function savePrivateMarginNote(
  input: Omit<StoredPrivateMarginNote, "createdAt" | "status" | "updatedAt"> &
    Partial<Pick<StoredPrivateMarginNote, "createdAt" | "status" | "updatedAt">>,
): StoredPrivateMarginNote {
  const now = Date.now();
  const scope = normalizeRuntimeScope(input.runtimeScope) ?? currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Private note runtime scope is unavailable");
  const notes = readPrivateMarginNotes();
  const existing = notes.find((note) => note.runtimeScope === scope && sameHex(note.commitment, input.commitment));
  const note: StoredPrivateMarginNote = {
    ...input,
    createdAt: input.createdAt ?? existing?.createdAt ?? now,
    noteFormat: input.noteFormat ?? existing?.noteFormat,
    runtimeScope: scope,
    status: input.status ?? "available",
    updatedAt: input.updatedAt ?? now,
  };
  writeNotes([
    note,
    ...notes.filter((existing) =>
      existing.runtimeScope !== scope || !sameHex(existing.commitment, note.commitment)),
  ]);
  return note;
}

export function confirmPrivateMarginDeposit(expected: StoredPrivateMarginNote): boolean {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope || expected.runtimeScope !== scope) return false;
  const notes = readPrivateMarginNotes();
  const current = notes.find((note) => note.runtimeScope === scope &&
    sameHex(note.commitment, expected.commitment) && sameHex(note.ownerCommitment, expected.ownerCommitment));
  if (!current || current.status !== "pending" || current.lockedByIntentCommitment ||
      current.claimSourceIntentCommitment || current.walletAddress !== expected.walletAddress ||
      current.amount !== expected.amount || current.noteNullifier !== expected.noteNullifier ||
      current.updatedAt !== expected.updatedAt || current.createdAt !== expected.createdAt) return false;
  writeNotes(notes.map((note) => note === current ? { ...note, status: "available" as const, updatedAt: Date.now() } : note));
  return true;
}

export function finalizePrivateMarginClaim(
  intentCommitment: Hex,
  commitment: Hex,
  ownerCommitment: Hex,
): StoredPrivateMarginNote {
  const notes = readPrivateMarginNotes();
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Private note runtime scope is unavailable");
  const target = notes.find((note) =>
    note.runtimeScope === scope &&
    note.commitment.toLowerCase() === commitment.toLowerCase() &&
    note.ownerCommitment.toLowerCase() === ownerCommitment.toLowerCase() &&
    note.claimSourceIntentCommitment?.toLowerCase() === intentCommitment.toLowerCase());
  if (!target) throw new Error("Confirmed recovery note is unavailable in this browser");
  const now = Date.now();
  const updated = { ...target, status: "available" as const, updatedAt: now };
  writeNotes(notes.map((note) => {
    if (note === target) return updated;
    if (
      note.ownerCommitment.toLowerCase() === ownerCommitment.toLowerCase() &&
      note.runtimeScope === scope &&
      note.claimSourceIntentCommitment?.toLowerCase() === intentCommitment.toLowerCase() &&
      note.status === "claiming"
    ) {
      return { ...note, status: "spent" as const, updatedAt: now };
    }
    return note;
  }));
  return updated;
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
  const excludedCommitments = new Set([...(input.excludedCommitments ?? [])].map((value) => value.toLowerCase()));
  const candidates = (input.notes ?? privateMarginNotes(input.ownerCommitment))
    .filter((note) => note.noteFormat === "secure")
    .filter((note) => sameHex(note.ownerCommitment, input.ownerCommitment))
    .filter((note) => note.status === "available")
    .filter((note) => !excludedCommitments.has(note.commitment.toLowerCase()))
    .filter((note) => !input.assetDigest || sameHex(note.assetDigest, input.assetDigest))
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
    .filter((note) => !input.assetDigest || sameHex(note.assetDigest, input.assetDigest))
    .filter((note) => !input.commitment || sameHex(note.commitment, input.commitment))
    .sort((left, right) => compareBigInt(BigInt(right.amount), BigInt(left.amount)));
  const note = candidates[0];
  if (note) return note;

  throw new Error(input.commitment ? "Selected private note is unavailable" : "No available collateral to withdraw");
}

export function lockPrivateMarginNote(commitment: Hex, intentCommitment: Hex): void {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Private note runtime scope is unavailable");
  const notes = readPrivateMarginNotes();
  const target = notes.find((note) => isCurrentNote(note, scope) && sameHex(note.commitment, commitment));
  if (!target || (target.status !== "available" &&
      !(target.status === "locked" && target.lockedByIntentCommitment && sameHex(target.lockedByIntentCommitment, intentCommitment)))) {
    throw new Error("Private margin input is already reserved or unavailable");
  }
  writeNotes(
    notes.map((note) =>
      isCurrentNote(note, scope) && sameHex(note.commitment, commitment)
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

export function reservePrivateMarginNotes(reservations: Array<{ commitment: Hex; intentCommitment: Hex }>): void {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Private note runtime scope is unavailable");
  const notes = readPrivateMarginNotes();
  const byCommitment = new Map(reservations.map((reservation) => [reservation.commitment.toLowerCase(), reservation]));
  if (byCommitment.size !== reservations.length) throw new Error("Private margin inputs must be distinct");
  const nullifiers = new Set<string>();
  for (const reservation of reservations) {
    const note = notes.find((value) => isCurrentNote(value, scope) && sameHex(value.commitment, reservation.commitment));
    if (!note || note.status !== "available") throw new Error("Private margin input is already reserved or unavailable");
    if (nullifiers.has(note.noteNullifier.toLowerCase())) throw new Error("Private margin inputs must be distinct");
    nullifiers.add(note.noteNullifier.toLowerCase());
  }
  const now = Date.now();
  writeNotes(notes.map((note) => {
    const reservation = isCurrentNote(note, scope) && byCommitment.get(note.commitment.toLowerCase());
    return reservation ? { ...note, status: "locked" as const, submissionPending: true, preparationOnly: true,
      lockedByIntentCommitment: reservation.intentCommitment, updatedAt: now } : note;
  }));
}

export function markPrivateMarginSubmissionAttempted(commitment: Hex, intentCommitment: Hex): void {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Private note runtime scope is unavailable");
  const notes = readPrivateMarginNotes();
  const source = notes.find((note) => isCurrentNote(note, scope) && sameHex(note.commitment, commitment));
  if (!source || source.status !== "locked" || !source.submissionPending || source.preparationOnly !== true ||
    !source.lockedByIntentCommitment || !sameHex(source.lockedByIntentCommitment, intentCommitment)) {
    throw new Error("Private margin preparation reservation changed before submission");
  }
  writeNotes(notes.map((note) => note === source ? { ...note, preparationOnly: false, updatedAt: Date.now() } : note));
}

/** Use only when this attempt has not sent its intent to the service. */
export function releasePrivateMarginPreparation(
  commitment: Hex,
  intentCommitment: Hex,
  options: { runtimeScope?: string; unavailable?: boolean; authoritativeActiveIntent?: Hex; ownerCommitment?: Hex } = {},
): void {
  const scope = options.runtimeScope === undefined ? currentPrivateMarginNoteRuntimeScope() : normalizeRuntimeScope(options.runtimeScope);
  if (!scope) return;
  const notes = readPrivateMarginNotes();
  const source = notes.find((note) => isCurrentNote(note, scope) && sameHex(note.commitment, commitment));
  if (source?.lockedByIntentCommitment && sameHex(source.lockedByIntentCommitment, intentCommitment) && source.preparationOnly === false) return;
  const owner = options.ownerCommitment ?? source?.ownerCommitment;
  if (!owner || (source && !sameHex(source.ownerCommitment, owner))) return;
  const ownsReservation = source?.status === "locked" && source.submissionPending && source.preparationOnly === true &&
    source.lockedByIntentCommitment && sameHex(source.lockedByIntentCommitment, intentCommitment);
  writeNotes(notes.map((note) => {
    if (note === source && ownsReservation) return options.authoritativeActiveIntent
      ? { ...note, status: "locked" as const, lockedByIntentCommitment: options.authoritativeActiveIntent,
        submissionPending: false, preparationOnly: false, updatedAt: Date.now() }
      : { ...note, status: options.unavailable ? "spent" as const : "available" as const, lockedByIntentCommitment: undefined,
        submissionPending: undefined, preparationOnly: undefined, updatedAt: Date.now() };
    if (isCurrentNote(note, scope) && sameHex(note.ownerCommitment, owner) &&
      note.status === "pending" && note.lockedByIntentCommitment && sameHex(note.lockedByIntentCommitment, intentCommitment)) {
      return { ...note, status: "spent" as const, submissionPending: undefined, preparationOnly: undefined, updatedAt: Date.now() };
    }
    return note;
  }));
}

export function markPrivateMarginNoteSpent(commitment: Hex): void {
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) throw new Error("Private note runtime scope is unavailable");
  writeNotes(
    readPrivateMarginNotes().map((note) =>
      isCurrentNote(note, scope) && sameHex(note.commitment, commitment)
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
  const scope = currentPrivateMarginNoteRuntimeScope();
  if (!scope) return;
  const orderStatus = reconciledOrderStatuses(input.orders, notes.filter((note) => isCurrentNote(note, scope)));
  let changed = false;
  const next = notes.map((note) => {
    if (!isCurrentNote(note, scope) || !note.lockedByIntentCommitment) return note;
    const status = orderStatus.get(intentCommitmentKey(note.lockedByIntentCommitment));
    if (!status) return note;

    if (status === "filled" || status === "partially-filled") {
      if (note.status === "locked") {
        changed = true;
        return {
          ...note,
          status: "spent" as const,
          submissionPending: undefined,
          preparationOnly: undefined,
          updatedAt: Date.now(),
        };
      }
      if (note.status === "pending") {
        changed = true;
        return {
          ...note,
          lockedByIntentCommitment: undefined,
          status: "available" as const,
          submissionPending: undefined,
          preparationOnly: undefined,
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
          submissionPending: undefined,
          preparationOnly: undefined,
          updatedAt: Date.now(),
        };
      }
      if (note.status === "pending") {
        changed = true;
        return {
          ...note,
          status: "spent" as const,
          submissionPending: undefined,
          preparationOnly: undefined,
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
    if (note.status !== "locked" || note.submissionPending || note.preparationOnly === false || !note.lockedByIntentCommitment) continue;
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
    case "filled":
      return 4;
    case "partially-filled":
      return 3;
    case "cancelled":
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

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isCurrentNote(note: StoredPrivateMarginNote, scope: string): boolean {
  return note.runtimeScope === scope && note.noteFormat === "secure";
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
  if (!/^\d+$/.test(String(note.amount)) || BigInt(note.amount) <= 0n) return undefined;
  if (note.status !== undefined && !["available", "locked", "pending", "claiming", "spent"].includes(note.status)) {
    return undefined;
  }
  if (note.submissionPending !== undefined && typeof note.submissionPending !== "boolean") return undefined;
  if (note.preparationOnly !== undefined && typeof note.preparationOnly !== "boolean") return undefined;
  return {
    amount: String(note.amount),
    assetDigest: note.assetDigest,
    blinding: note.blinding,
    commitment: note.commitment,
    createdAt: Number(note.createdAt ?? Date.now()),
    lockedByIntentCommitment: note.lockedByIntentCommitment,
    claimSourceIntentCommitment: note.claimSourceIntentCommitment,
    noteNullifier: note.noteNullifier,
    noteFormat: note.noteFormat === "secure" ? "secure" : undefined,
    ownerCommitment: note.ownerCommitment,
    ownerDigest: note.ownerDigest,
    rhoDigest: note.rhoDigest,
    runtimeScope: normalizeRuntimeScope(note.runtimeScope),
    spendSecretDigest: note.spendSecretDigest,
    status: normalizeStatus(note.status),
    submissionPending: note.submissionPending,
    preparationOnly: note.preparationOnly,
    updatedAt: Number(note.updatedAt ?? Date.now()),
    walletAddress: note.walletAddress,
  };
}

function normalizeStatus(value: unknown): PrivateMarginNoteStatus {
  return value === "locked" || value === "pending" || value === "claiming" || value === "spent"
    ? value : "available";
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
