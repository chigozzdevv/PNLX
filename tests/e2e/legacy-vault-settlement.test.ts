import { expect, test } from "bun:test";
import { digestToFieldHex, ownerCommitment } from "@pnlx/crypto";
import type { Hex, PositionCloseRecord, PositionLifecycleRecord } from "@pnlx/protocol-types";
import type { ServerEnv } from "@/config/env";
import { LegacyExitRecoveryService } from "@/features/notes/legacy-exit-recovery";
import { ProtocolStore } from "@/shared/state/store";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import { assertMakerPositionCloseOrigin, makerCloseRecoveryAmount } from "../../scripts/operations/settle-vault-maker-position";
import { fieldHex, secureMarginCommitment, secureMarginNullifier, secureMarginProof } from "@pnlx/crypto";
import { createProver } from "@/workers/prover/prover.worker";
import { proveMakerNoteWithdrawal } from "../../scripts/operations/withdraw-maker-notes";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";

const helper = "CBDBUPESYVEB5YIBMFK5TJOW54RHMUYNL7C47TLM6DHTUCEKJGK57UBK";
const maker = "GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";
const key = (label: string): Hex => digestToFieldHex(`legacy-vault-settlement:${label}`);

function fixture(refund: Hex = key("refund")) {
  const store = new ProtocolStore();
  const position: PositionLifecycleRecord = { batchId: "old-funded", marketId: "xlm-usd-perp",
    positionCommitment: key("position"), positionNullifier: key("nullifier"), ownerCommitment: ownerCommitment(maker),
    sourceIntentCommitment: key("intent"), settlementDigest: key("settlement"), status: "closed",
    openedAt: 1, updatedAt: 2, closeCommitment: key("close"), marginOutputCommitment: refund };
  const close: PositionCloseRecord = { marketId: position.marketId, markPrice: 150n, currentFundingIndex: -3n,
    positionCommitment: position.positionCommitment, positionNullifier: position.positionNullifier,
    positionRoot: key("root"), closeCommitment: key("close"), newPositionCommitment: key("terminal"),
    marginOutputCommitment: refund, settlementTxHash: key("transaction"),
    proof: { circuitId: "legacy-position-close-pair", circuitKey: key("circuit"), circuitHash: key("source"),
      verifierHash: key("verifier"), publicInputHash: key("public"), proofDigest: key("proof") } };
  store.positionLifecycle.set(position.positionCommitment, position);
  store.positionCloses.set(close.closeCommitment, close);
  let receipt = { ledger: 123,
    position_commitments: [position.positionCommitment, key("other-position")],
    position_nullifiers: [position.positionNullifier, key("other-nullifier")],
    close_commitments: [close.closeCommitment, key("other-close")],
    margin_output_commitments: [close.marginOutputCommitment, key("other-refund")] };
  let status = "SUCCESS", eventHash = close.settlementTxHash!, reads = 0;
  const relayer = {
    async readAsync(request: { payload: { contractId: string; functionName: string } }) {
      expect(request.payload.contractId).toBe(helper); expect(request.payload.functionName).toBe("receipt_by_close");
      reads++; return { stdout: JSON.stringify(receipt), output: JSON.stringify(receipt) };
    },
    async findContractEventTransaction(contract: string, ledger: number, commitment: Hex) {
      expect(contract).toBe(helper); expect(ledger).toBe(123); expect(commitment).toBe(close.closeCommitment); return eventHash;
    },
    async readTransactionStatus(hash: Hex) { expect(hash).toBe(close.settlementTxHash!); return status; },
  } as unknown as RelayerService;
  const service = (trusted: string | undefined = helper) => new LegacyExitRecoveryService({} as ServerEnv, relayer, trusted);
  const input = { positionCommitment: position.positionCommitment, noteCommitment: close.marginOutputCommitment,
    closeTxHash: close.settlementTxHash!, maker };
  return { store, position, close, input, service, setStatus: (value: string) => { status = value; },
    setEventHash: (value: Hex) => { eventHash = value; },
    setNullifier: (value: Hex) => { receipt = { ...receipt, position_nullifiers: [value, key("other-nullifier")] }; },
    reads: () => reads };
}

test("legacy maker principal can reconcile only through the exact funded helper output and successful event transaction", async () => {
  const f = fixture();
  await assertMakerPositionCloseOrigin(f.store, f.input, f.service());
  expect(f.reads()).toBe(1);
  expect(f.store.positionCloses.size).toBe(1);
  expect(f.store.positionLifecycle.get(f.position.positionCommitment)?.status).toBe("closed");
  for (const status of ["FAILED", "NOT_FOUND", "PENDING"]) {
    f.setStatus(status);
    await expect(assertMakerPositionCloseOrigin(f.store, f.input, f.service())).rejects.toThrow("not confirmed");
  }
  f.setStatus("SUCCESS"); f.setEventHash(key("unrelated-success"));
  await expect(assertMakerPositionCloseOrigin(f.store, f.input, f.service())).rejects.toThrow("not confirmed");
});

test("legacy circuit name alone cannot authorize settlement from an untrusted helper or another source nullifier", async () => {
  const f = fixture();
  await expect(assertMakerPositionCloseOrigin(f.store, f.input, f.service("C" + "A".repeat(55)))).rejects.toThrow();
  f.setNullifier(key("wrong-funded-nullifier"));
  await expect(assertMakerPositionCloseOrigin(f.store, f.input, f.service())).rejects.toThrow("immutable funded helper source");
});

test("another owner's position, replaced close or different refund cannot release maker principal", async () => {
  const f = fixture();
  await expect(assertMakerPositionCloseOrigin(f.store, { ...f.input, maker: "G" + "A".repeat(55) }, f.service())).rejects.toThrow("confirmed paired close");
  await expect(assertMakerPositionCloseOrigin(f.store, { ...f.input, noteCommitment: key("wrong-output") }, f.service())).rejects.toThrow("confirmed paired close");
  f.store.positionCloses.set(f.close.closeCommitment, { ...f.close, positionNullifier: key("replaced-nullifier") });
  await expect(assertMakerPositionCloseOrigin(f.store, f.input, f.service())).rejects.toThrow("confirmed paired close");
  expect(f.reads()).toBe(0);
});

test("normal paired close origin retains its existing path while unsupported single proofs remain rejected", async () => {
  const f = fixture();
  f.store.positionCloses.set(f.close.closeCommitment, { ...f.close, proof: { ...f.close.proof, circuitId: "position-close-pair" } });
  await assertMakerPositionCloseOrigin(f.store, f.input, f.service());
  expect(f.reads()).toBe(0);
  f.store.positionCloses.set(f.close.closeCommitment, { ...f.close, proof: { ...f.close.proof, circuitId: "position-close" } });
  await expect(assertMakerPositionCloseOrigin(f.store, f.input, f.service())).rejects.toThrow("supported paired close");
});

test("a confirmed zero legacy refund records a real loss without withdrawing zero or inventing returned principal", async () => {
  const opening = { amount: 0n, assetDigest: fieldHex(1n), ownerDigest: fieldHex(2n),
    rhoDigest: fieldHex(3n), blinding: fieldHex(4n), spendSecretDigest: fieldHex(5n) };
  const f = fixture(secureMarginCommitment(opening));
  const note = { ...opening, amount: "0", status: "draining", commitment: secureMarginCommitment(opening),
    closePositionCommitment: f.position.positionCommitment, closeTxHash: f.input.closeTxHash };
  expect(makerCloseRecoveryAmount(note)).toBe(0n);
  await assertMakerPositionCloseOrigin(f.store, f.input, f.service());
  expect(() => makerCloseRecoveryAmount({ ...note, amount: "1", status: "spent", recoveredAmount: "1" })).toThrow("commitment");
});

test("a legacy maker refund uses the real secure withdrawal circuit and twenty-level pool membership", () => {
  const opening = { amount: 40n, assetDigest: key("asset"), ownerDigest: digestToFieldHex(`owner:${ownerCommitment(maker)}`),
    rhoDigest: key("rho"), blinding: key("blind"), spendSecretDigest: key("private-refund-spend") };
  const commitment = secureMarginCommitment(opening), recipient = key("recipient");
  const note = { ...opening, amount: "40", commitment, noteNullifier: secureMarginNullifier(opening),
    status: "draining", walletAddress: maker };
  const membership = secureMarginProof([commitment], commitment);
  expect(membership.siblings).toHaveLength(20);
  const prover = createProver();
  const withdrawal = proveMakerNoteWithdrawal(prover, note, membership, recipient, opening.assetDigest);
  expect(withdrawal.proof.circuitId).toBe("secure-withdraw");
  expect(withdrawal.withdrawAmount).toBe(40n);
  expect(withdrawal.changeCommitment).toBe("0x0");
  expect(withdrawal.proof.publicInputHash).toBe(contractPublicInputHash([
    publicU128(40n), publicField(membership.root), publicField(note.noteNullifier),
    publicField(opening.assetDigest), publicField(recipient), publicField("0x0"),
  ]));
  expect(prover.artifactFor(withdrawal.proof)?.publicInputsHash).toBe(withdrawal.proof.publicInputHash);
  expect(() => proveMakerNoteWithdrawal(prover, { ...note, amount: "41" }, membership, recipient, opening.assetDigest)).toThrow("opening mismatch");
}, 30_000);
