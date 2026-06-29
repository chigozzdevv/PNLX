import { assertAuthenticatedOwnerCommitment } from "../../shared/http/auth-context";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type {
  GetAccountKeyInput,
  GetAccountKeyResult,
  UpsertAccountKeyInput,
  UpsertAccountKeyResult,
} from "./account-keys.model";

export class AccountKeysService {
  constructor(private readonly executor: ExecutorService) {}

  upsert(input: UpsertAccountKeyInput, authenticated?: string): UpsertAccountKeyResult {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    const existing = this.executor.store.accountEncryptionKey(input.ownerCommitment);
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
}
