import { assertAuthenticatedOwnerCommitment } from "@/shared/http/auth-context";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type {
  GetAccountKeyInput,
  GetAccountKeyResult,
  RecoverAccountKeyInput,
  RecoverAccountKeyResult,
  UpsertAccountKeyInput,
  UpsertAccountKeyResult,
} from "@/features/account-keys/account-keys.model";
import { recoverConfirmedCloseOutputEventsForOwner, recoverPositionOpeningEventsForOwner } from "@/features/account-keys/account-key-recovery";
import type { LegacyExitRecoveryService } from "@/features/notes/legacy-exit-recovery";

export class AccountKeysService {
  constructor(private readonly executor: ExecutorService, private readonly legacyExitRecovery?: LegacyExitRecoveryService) {}

  upsert(input: UpsertAccountKeyInput, authenticated?: string): UpsertAccountKeyResult {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    const existing = this.executor.store.accountEncryptionKey(input.ownerCommitment);
    if (existing && existing.publicKey !== input.publicKey) {
      throw new Error("account encryption key is already registered for this owner");
    }

    const now = Date.now();
    const record = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.executor.store.upsertAccountEncryptionKey(record);
    return record;
  }

  get(input: GetAccountKeyInput, authenticated?: string): GetAccountKeyResult {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    return this.executor.store.accountEncryptionKey(input.ownerCommitment) ?? null;
  }

  recover(input: RecoverAccountKeyInput, authenticated?: string): RecoverAccountKeyResult {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    const existing = this.executor.store.accountEncryptionKey(input.ownerCommitment);
    const now = Date.now();
    const accountKey = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.executor.store.upsertAccountEncryptionKey(accountKey);
    const recovery = recoverPositionOpeningEventsForOwner(
      this.executor.store,
      input.ownerCommitment,
      input.publicKey,
    );
    const closeRecovery = recoverConfirmedCloseOutputEventsForOwner(this.executor.store, input.ownerCommitment, input.publicKey);
    recovery.events.push(...closeRecovery.events);
    recovery.skipped.push(...closeRecovery.skipped);
    for (const event of recovery.events) {
      this.executor.store.addAccountEvent(event);
    }

    return {
      accountKey,
      repairedEventCount: recovery.events.length,
      skipped: recovery.skipped,
    };
  }

  async recoverDurable(input: RecoverAccountKeyInput, authenticated?: string): Promise<RecoverAccountKeyResult> {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    const legacyRecovery = await this.legacyExitRecovery?.recoverEvents(this.executor.store, input.ownerCommitment, input.publicKey);
    const result = this.recover(input, authenticated);
    for (const event of legacyRecovery?.events ?? []) this.executor.store.addAccountEvent(event);
    result.repairedEventCount += legacyRecovery?.events.length ?? 0;
    result.skipped.push(...(legacyRecovery?.skipped ?? []));
    await (this.executor.store as { flush?: () => Promise<void> }).flush?.();
    return result;
  }
}
