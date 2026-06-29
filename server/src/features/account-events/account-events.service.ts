import { assertAuthenticatedOwnerCommitment } from "../../shared/http/auth-context";
import type { ExecutorService } from "../../workers/executor/executor.service";
import type {
  CreateAccountEventInput,
  CreateAccountEventResult,
  ListAccountEventsInput,
  ListAccountEventsResult,
} from "./account-events.model";

export class AccountEventsService {
  constructor(private readonly executor: ExecutorService) {}

  create(input: CreateAccountEventInput, authenticated?: string): CreateAccountEventResult {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    const record = {
      ...input,
      createdAt: Date.now(),
    };
    this.executor.store.addAccountEvent(record);
    return record;
  }

  list(input: ListAccountEventsInput, authenticated?: string): ListAccountEventsResult {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    return this.executor.store.accountEventsFor(input.ownerCommitment);
  }
}
