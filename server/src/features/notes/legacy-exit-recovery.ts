import { MongoClient } from "mongodb";
import { digestToFieldHex, hashFields, secureMarginCommitment, secureMarginNullifier } from "@pnlx/crypto";
import type { AccountEventRecord, Hex } from "@pnlx/protocol-types";
import type { ServerEnv } from "@/config/env";
import type { AccountKeyRecovery } from "@/features/account-keys/account-key-recovery";
import { encryptAccountEventPayload } from "@/shared/protocol/account-event-encryption";
import type { ProtocolStore } from "@/shared/state/store";
import type { RelayerService } from "@/workers/relayer/relayer.service";

const HEX = /^0x[0-9a-f]{64}$/i;
const CONTRACT = /^C[A-Z2-7]{55}$/;

export interface LegacyExitBinding {
  helperContractId: string;
  transactionHash: Hex;
  closeCommitment: Hex;
  outputIndex: 0 | 1;
}

export interface ConfirmedLegacyExitBinding extends LegacyExitBinding {
  confirmed: true;
  positionCommitment: Hex;
  positionNullifier: Hex;
}

export interface LegacyExitOutputArchive {
  ownerCommitment: Hex;
  createdAt: number;
  confirmed: true;
  legacyExit: LegacyExitBinding;
  positionClose: {
    closeCommitment: Hex;
    positionCommitment: Hex;
    positionNullifier: Hex;
    marginOutputCommitment: Hex;
    [key: string]: unknown;
  };
  closeOutputNote: {
    amount: string;
    assetDigest: Hex;
    blinding: Hex;
    commitment: Hex;
    noteNullifier: Hex;
    ownerDigest: Hex;
    rhoDigest: Hex;
    spendSecretDigest: Hex;
  };
}

function parseHex(value: unknown): Hex {
  if (typeof value !== "string" || !HEX.test(value)) throw new Error("Invalid legacy exit receipt hash");
  return value.toLowerCase() as Hex;
}

export function parseLegacyExitBinding(value: unknown): LegacyExitBinding {
  if (!value || typeof value !== "object") throw new Error("Invalid legacy exit receipt binding");
  const input = value as Record<string, unknown>;
  if (typeof input.helperContractId !== "string" || !CONTRACT.test(input.helperContractId) ||
      (input.outputIndex !== 0 && input.outputIndex !== 1)) throw new Error("Invalid legacy exit receipt binding");
  return { helperContractId: input.helperContractId, transactionHash: parseHex(input.transactionHash),
    closeCommitment: parseHex(input.closeCommitment), outputIndex: input.outputIndex };
}

export function createLegacyExitAccountEvent(archive: LegacyExitOutputArchive, publicKey: string): AccountEventRecord {
  const ciphertext = encryptAccountEventPayload({ kind: "legacy-position-close", legacyExit: archive.legacyExit,
    positionClose: archive.positionClose, closeOutputNote: archive.closeOutputNote }, publicKey);
  const dataCommitment = hashFields("legacy-position-close-event", [archive.ownerCommitment,
    archive.legacyExit.helperContractId, archive.legacyExit.transactionHash, archive.legacyExit.closeCommitment,
    archive.legacyExit.outputIndex, archive.positionClose.positionCommitment, archive.closeOutputNote.commitment, ciphertext]);
  return { ciphertext, createdAt: archive.createdAt, dataCommitment, ownerCommitment: archive.ownerCommitment,
    eventId: hashFields("legacy-position-close-event-id", [archive.ownerCommitment, archive.legacyExit.closeCommitment, dataCommitment]) };
}

export class LegacyExitRecoveryService {
  constructor(
    private readonly env: ServerEnv,
    private readonly relayer: RelayerService,
    private readonly helperContractId: string | undefined,
    private readonly readArchives?: (owner: Hex) => Promise<LegacyExitOutputArchive[]>,
  ) {}

  assertTrustedBinding(binding: LegacyExitBinding): void {
    if (!this.helperContractId || !CONTRACT.test(this.helperContractId) || binding.helperContractId !== this.helperContractId) {
      throw new Error("Legacy exit helper is not trusted by this deployment");
    }
  }

  async verifyOutput(binding: LegacyExitBinding, commitment: Hex): Promise<ConfirmedLegacyExitBinding> {
    this.assertTrustedBinding(binding);
    return this.verifyReceiptOutput(binding, commitment, await this.readReceipt(binding.closeCommitment));
  }

  async verifyCloseOutput(transactionHash: Hex, closeCommitment: Hex, commitment: Hex): Promise<ConfirmedLegacyExitBinding> {
    const trusted = parseLegacyExitBinding({ helperContractId: this.helperContractId, transactionHash, closeCommitment, outputIndex: 0 });
    this.assertTrustedBinding(trusted);
    const receipt = await this.readReceipt(trusted.closeCommitment);
    const closes = this.receiptHashes(receipt, "close_commitments");
    const outputIndex = closes.indexOf(trusted.closeCommitment);
    if (outputIndex !== 0 && outputIndex !== 1) throw new Error("Legacy close is absent from its immutable helper receipt");
    return this.verifyReceiptOutput({ ...trusted, outputIndex }, commitment, receipt);
  }

  private async readReceipt(closeCommitment: Hex): Promise<Record<string, unknown>> {
    const result = await this.relayer.readAsync({ kind: "contract-invoke", payload: {
      contractId: this.helperContractId!, functionName: "receipt_by_close", send: "no",
      args: ["--close_commitment", closeCommitment.slice(2)],
    } });
    const output = (result.stdout ?? result.output).trim();
    if (output.length > 32_768) throw new Error("Legacy exit receipt response is invalid");
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(output); } catch { throw new Error("Legacy exit receipt is unavailable"); }
    if (!receipt || typeof receipt !== "object" || !Number.isSafeInteger(receipt.ledger) ||
        (receipt.ledger as number) <= 0 || (receipt.ledger as number) >= 0xffff_ffff) {
      throw new Error("Legacy exit receipt is unavailable");
    }
    return receipt;
  }

  private receiptHashes(receipt: Record<string, unknown>, name: string): Hex[] {
    const values = receipt[name];
    if (!Array.isArray(values) || values.length !== 2) throw new Error("Legacy exit receipt pair is invalid");
    return values.map(value => parseHex(typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? `0x${value}` : value));
  }

  private async verifyReceiptOutput(binding: LegacyExitBinding, commitment: Hex, receipt: Record<string, unknown>): Promise<ConfirmedLegacyExitBinding> {
    const positions = this.receiptHashes(receipt, "position_commitments"), nullifiers = this.receiptHashes(receipt, "position_nullifiers");
    const closes = this.receiptHashes(receipt, "close_commitments"), outputs = this.receiptHashes(receipt, "margin_output_commitments");
    if (positions[0] === positions[1] || nullifiers[0] === nullifiers[1] || closes[0] === closes[1] ||
        closes[binding.outputIndex] !== binding.closeCommitment || outputs[binding.outputIndex] !== commitment.toLowerCase()) {
      throw new Error("Legacy exit output does not match its immutable helper receipt");
    }
    const transactionHash = await this.relayer.findContractEventTransaction(this.helperContractId!, receipt.ledger as number, binding.closeCommitment);
    if (transactionHash.toLowerCase() !== binding.transactionHash ||
        await this.relayer.readTransactionStatus(binding.transactionHash) !== "SUCCESS") {
      throw new Error("Legacy exit transaction is not confirmed for this helper receipt");
    }
    return { ...binding, confirmed: true, positionCommitment: positions[binding.outputIndex]!,
      positionNullifier: nullifiers[binding.outputIndex]! };
  }

  async recoverEvents(store: ProtocolStore, owner: Hex, publicKey: string): Promise<AccountKeyRecovery> {
    if (!this.helperContractId) return { events: [], skipped: [] };
    const archives = await this.loadArchives(owner);
    if (archives.length > 6) throw new Error("Legacy exit output archive exceeds its bounded migration");
    const events: AccountEventRecord[] = [], skipped: AccountKeyRecovery["skipped"] = [];
    for (const archive of archives) {
      try {
        const binding = parseLegacyExitBinding(archive.legacyExit);
        const record = archive.positionClose, note = archive.closeOutputNote;
        if (archive.confirmed !== true || archive.ownerCommitment !== owner ||
            !Number.isSafeInteger(archive.createdAt) || archive.createdAt <= 0 ||
            !record || !note || record.closeCommitment !== binding.closeCommitment ||
            typeof note.amount !== "string" || !/^\d+$/.test(note.amount) || BigInt(note.amount) >= (1n << 128n)) {
          throw new Error("Legacy exit archive binding is invalid");
        }
        const position = store.positionLifecycle.get(parseHex(record.positionCommitment));
        if (!position || position.ownerCommitment !== owner || position.status !== "closed" ||
            position.closeCommitment !== binding.closeCommitment || position.marginOutputCommitment !== note.commitment ||
            record.marginOutputCommitment !== note.commitment ||
            !store.marginCommitments.has(note.commitment)) throw new Error("Legacy exit output is not the confirmed funded lifecycle result");
        const opening = { amount: BigInt(note.amount), assetDigest: parseHex(note.assetDigest), blinding: parseHex(note.blinding),
          ownerDigest: parseHex(note.ownerDigest), rhoDigest: parseHex(note.rhoDigest), spendSecretDigest: parseHex(note.spendSecretDigest) };
        if (opening.ownerDigest !== digestToFieldHex(`owner:${owner}`) ||
            secureMarginCommitment(opening) !== note.commitment || secureMarginNullifier(opening) !== note.noteNullifier) {
          throw new Error("Legacy exit opening does not match its funded note");
        }
        const confirmed = await this.verifyOutput(binding, note.commitment);
        if (confirmed.positionCommitment !== record.positionCommitment || confirmed.positionNullifier !== record.positionNullifier) {
          throw new Error("Legacy exit source does not match its helper receipt");
        }
        if (opening.amount > 0n) events.push(createLegacyExitAccountEvent(archive, publicKey));
      } catch {
        const position = archive?.positionClose?.positionCommitment;
        if (typeof position === "string" && HEX.test(position)) skipped.push({ positionCommitment: position as Hex,
          reason: "confirmed legacy exit refund could not be verified" });
      }
    }
    return { events, skipped };
  }

  private async loadArchives(owner: Hex): Promise<LegacyExitOutputArchive[]> {
    if (this.readArchives) return this.readArchives(owner);
    if (!this.env.mongodbUri) throw new Error("Legacy exit output recovery archive is unavailable");
    const client = new MongoClient(this.env.mongodbUri, { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, socketTimeoutMS: 10_000 });
    try {
      await client.connect();
      return await client.db(this.env.mongodbDatabase).collection<LegacyExitOutputArchive>(`${this.env.mongodbCollection}_legacy_exit_outputs`)
        .find({ ownerCommitment: owner, confirmed: true, "legacyExit.helperContractId": this.helperContractId }, { maxTimeMS: 10_000 })
        .limit(7).toArray();
    } catch { throw new Error("Legacy exit output recovery archive is unavailable"); }
    finally { await client.close(); }
  }
}
