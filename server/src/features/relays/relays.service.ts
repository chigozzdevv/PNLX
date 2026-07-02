import type { RelayerService } from "@/workers/relayer/relayer.service";
import type { ServerEnv } from "@/config/env";
import { assertProtocolAdmin } from "@/shared/http/auth-context";
import type { CreateRelayInput, SubmitSignedXdrInput } from "@/features/relays/relays.model";
import type { ExecutorService } from "@/workers/executor/executor.service";

export class RelaysService {
  constructor(
    private readonly relayer: RelayerService,
    private readonly env: ServerEnv,
    private readonly executor?: Pick<ExecutorService, "store">,
  ) {}

  create(input: CreateRelayInput, authenticated?: string) {
    assertProtocolAdmin(authenticated, this.env.protocolAdminAddresses, {
      required: this.env.protocolAdminRequired,
    });
    return this.relayer.relay(input);
  }

  submitSignedXdr(input: SubmitSignedXdrInput, authenticated?: string) {
    const expectedTxHash = this.expectedPreparedTxHash(input, authenticated) ?? input.expectedTxHash;
    return this.relayer.submitSignedXdr({
      ...input,
      expectedTxHash,
      submittedBy: authenticated,
    });
  }

  list() {
    return this.relayer.list();
  }

  private expectedPreparedTxHash(input: SubmitSignedXdrInput, authenticated?: string) {
    if (!input.commitment || !this.executor) return undefined;

    const pending = this.executor.store.pendingAssetDeposits.get(input.commitment);
    if (!pending) throw new Error("pending asset deposit not found");
    if (pending.finalizedAt) throw new Error("asset deposit already finalized");
    if (input.preparedXdrDigest && pending.preparedXdrDigest !== input.preparedXdrDigest) {
      throw new Error("signed deposit relay prepared transaction mismatch");
    }
    if (authenticated && pending.from.trim().toUpperCase() !== authenticated.trim().toUpperCase()) {
      throw new Error("signed deposit relay submitter mismatch");
    }
    return pending.preparedTxHash;
  }
}
