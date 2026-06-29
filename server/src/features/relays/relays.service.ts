import type { RelayerService } from "../../workers/relayer/relayer.service";
import type { ServerEnv } from "../../config/env";
import { assertProtocolAdmin } from "../../shared/http/auth-context";
import type { CreateRelayInput, SubmitSignedXdrInput } from "./relays.model";

export class RelaysService {
  constructor(private readonly relayer: RelayerService, private readonly env: ServerEnv) {}

  create(input: CreateRelayInput, authenticated?: string) {
    assertProtocolAdmin(authenticated, this.env.protocolAdminAddresses, {
      required: this.env.protocolAdminRequired,
    });
    return this.relayer.relay(input);
  }

  submitSignedXdr(input: SubmitSignedXdrInput, authenticated?: string) {
    return this.relayer.submitSignedXdr({
      ...input,
      submittedBy: authenticated,
    });
  }

  list() {
    return this.relayer.list();
  }
}
