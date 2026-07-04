import { json, readJson } from "@/shared/http/json";
import { authenticatedAddress } from "@/shared/http/auth-context";
import {
  parseAssetDepositNote,
  parseDepositNote,
  parseFinalizeAssetDeposit,
  parseProvenAssetDepositNote,
  parseProvenWithdrawAssetNote,
  parseProvenWithdrawNote,
  parseWithdrawAssetNote,
  parseWithdrawNote,
} from "@/features/notes/notes.schema";
import type { NotesService } from "@/features/notes/notes.service";

export class NotesController {
  constructor(private readonly notes: NotesService) {}

  membership(request: Request): Response {
    const commitment = new URL(request.url).searchParams.get("commitment");
    if (!commitment) throw new Error("commitment is required");
    return json({ note: this.notes.membership(commitment as `0x${string}`) });
  }

  addressDigest(request: Request): Response {
    const address = new URL(request.url).searchParams.get("address");
    if (!address) throw new Error("address is required");
    return json({ digest: this.notes.addressDigest(address) });
  }

  async deposit(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ note: this.notes.deposit(parseDepositNote(body)) }, 201);
  }

  async prepareDepositAsset(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json(
      this.notes.prepareDepositAsset(parseAssetDepositNote(body), authenticatedAddress(request)),
      201,
    );
  }

  async prepareDepositAssetProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json(
      this.notes.prepareDepositAssetProven(
        parseProvenAssetDepositNote(body),
        authenticatedAddress(request),
      ),
      201,
    );
  }

  async depositAsset(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json(
      { note: this.notes.depositAsset(parseAssetDepositNote(body), authenticatedAddress(request)) },
      201,
    );
  }

  async depositAssetProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json(
      {
        note: this.notes.depositAssetProven(
          parseProvenAssetDepositNote(body),
          authenticatedAddress(request),
        ),
      },
      201,
    );
  }

  async finalizeDepositAsset(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json(
      {
        note: this.notes.finalizeDepositAsset(
          parseFinalizeAssetDeposit(body),
          authenticatedAddress(request),
        ),
      },
      201,
    );
  }

  async withdraw(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ withdrawal: this.notes.withdraw(parseWithdrawNote(body)) }, 201);
  }

  async withdrawProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ withdrawal: this.notes.withdrawProven(parseProvenWithdrawNote(body)) }, 201);
  }

  async withdrawAsset(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ withdrawal: this.notes.withdrawAsset(parseWithdrawAssetNote(body)) }, 201);
  }

  async withdrawAssetProven(request: Request): Promise<Response> {
    const body = await readJson<Record<string, string>>(request);
    return json({ withdrawal: this.notes.withdrawAssetProven(parseProvenWithdrawAssetNote(body)) }, 201);
  }
}
