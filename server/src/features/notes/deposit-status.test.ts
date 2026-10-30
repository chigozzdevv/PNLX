import { describe, expect, test } from "bun:test";
import { fieldHex } from "@pnlx/crypto";
import type { Hex, PendingAssetDepositRecord } from "@pnlx/protocol-types";
import { ProtocolStore } from "@/shared/state/store";
import { Router } from "@/shared/http/router";
import { NotesService } from "./notes.service";
import { registerNotesRoute } from "./notes.route";
import { parseAssetDepositStatus } from "./notes.schema";
import { OnchainRelayService } from "@/workers/onchain/onchain.service";

const ADDRESS = "GCXW7ZMGSP4RK4LQHO2GMNT4DC4PKEFOQIL5U3ET6HREGJYPENQLQ7RH";
const OTHER = "GCLGNRTRKZ3GND4T64HHMOQZLEIWNJJ2JEQH6WHXUKLOIMJT7OXWBVBI";
const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
function fixture() {
  const store = new ProtocolStore();
  const pending: PendingAssetDepositRecord = { amount: 100n, commitment: fieldHex(1n), from: ADDRESS, token: TOKEN,
    tokenDigest: fieldHex(2n), preparedTxHash: fieldHex(3n), preparedXdrDigest: fieldHex(4n), createdAt: 1,
    depositProof: { amount: 100n, commitment: fieldHex(1n), tokenDigest: fieldHex(2n), proof: {} as never } };
  store.addPendingAssetDeposit(pending);
  let tx: "FAILED" | "SUCCESS" | "NOT_FOUND" = "FAILED", funded = false, fail = false;
  let onRead: (() => void) | undefined;
  const reads: string[] = [];
  const onchain = { enabled: true,
    async depositTransactionStatusAsync(hash: Hex) { reads.push(`tx:${hash}`); if (fail) throw new Error("RPC unavailable"); onRead?.(); return tx; },
    async isMarginCommitmentRecordedAsync(commitment: Hex) { reads.push(`commitment:${commitment}`); return funded; },
  };
  const env = { collateralTokenContract: TOKEN, assetCustodyRequired: true };
  const service = new NotesService({ store } as never, {} as never, env as never, onchain as never);
  const input = { commitment: pending.commitment, expectedTxHash: pending.preparedTxHash! };
  return { store, pending, onchain, env, service, input, reads,
    transaction(value: typeof tx) { tx = value; }, funded() { funded = true; }, fail() { fail = true; },
    onRead(value: () => void) { onRead = value; } };
}

describe("owner-bound failed-deposit status", () => {
  test("reads the configured pool and accepts only an authoritative boolean", async () => {
    const calls: unknown[] = []; let stdout: string | undefined = "false";
    const chain = new OnchainRelayService({ async readAsync(input: unknown) { calls.push(input); return { stdout }; } } as never,
      { enabled: true, deployment: { contracts: { "shielded-pool": "configured-pool" } } as never });
    expect(await chain.isMarginCommitmentRecordedAsync(fieldHex(1n))).toBe(false);
    expect(calls[0]).toEqual({ kind: "contract-invoke", payload: { contractId: "configured-pool", functionName: "has_commitment",
      args: ["--commitment", fieldHex(1n).slice(2)], send: "no" } });
    stdout = "true"; expect(await chain.isMarginCommitmentRecordedAsync(fieldHex(1n))).toBe(true);
    for (const invalid of [undefined, "", "null", '"false"', "0", "unknown"]) {
      stdout = invalid;
      await expect(chain.isMarginCommitmentRecordedAsync(fieldHex(1n))).rejects.toThrow("invalid deposit commitment status");
    }
  });

  test("returns only bound public status and permits only a conclusively failed unfunded envelope", async () => {
    const f = fixture(), original = structuredClone(f.pending);
    expect(await f.service.depositAssetStatus(f.input, ADDRESS)).toEqual({ ...f.input, from: ADDRESS, token: TOKEN,
      amount: 100n, tokenDigest: f.pending.tokenDigest, transactionStatus: "FAILED", canRetry: true });
    expect(f.reads).toEqual([`tx:${f.input.expectedTxHash}`, `commitment:${f.input.commitment}`]);
    expect(f.pending).toEqual(original); expect(f.store.marginCommitments.size).toBe(0);
  });

  test("never permits successful, unknown, funded, locally credited or finalized deposits", async () => {
    for (const tx of ["SUCCESS", "NOT_FOUND"] as const) {
      const f = fixture(); f.transaction(tx); expect((await f.service.depositAssetStatus(f.input, ADDRESS)).canRetry).toBe(false);
    }
    const mutations = [
      (f: ReturnType<typeof fixture>) => f.funded(),
      (f: ReturnType<typeof fixture>) => { f.pending.finalizedAt = 1; },
      (f: ReturnType<typeof fixture>) => f.store.marginCommitments.add(f.input.commitment),
      (f: ReturnType<typeof fixture>) => { f.pending.txHash = f.input.expectedTxHash; },
      (f: ReturnType<typeof fixture>) => { f.pending.preparedTxHash = fieldHex(9n); },
      (f: ReturnType<typeof fixture>) => { f.pending.depositProof.amount = 999n; },
      (f: ReturnType<typeof fixture>) => { f.pending.depositProof.tokenDigest = fieldHex(9n); },
      (f: ReturnType<typeof fixture>) => { f.pending.depositProof.commitment = fieldHex(9n); },
    ];
    for (const mutate of mutations) {
      const f = fixture(); mutate(f); expect((await f.service.depositAssetStatus(f.input, ADDRESS)).canRetry).toBe(false);
    }
  });

  test("requires ownership before network reads and rejects malformed query bindings", async () => {
    const f = fixture();
    await expect(f.service.depositAssetStatus(f.input)).rejects.toThrow("authenticated deposit owner");
    await expect(f.service.depositAssetStatus(f.input, OTHER)).rejects.toThrow("authenticated account");
    expect(f.reads).toHaveLength(0);
    expect(() => parseAssetDepositStatus(new Request("http://127.0.0.1/notes/deposit-asset/status?commitment=0x1")))
      .toThrow("32-byte");
  });

  test("unavailable readers and concurrent local mutation fail closed", async () => {
    const failed = fixture(); failed.fail(); expect((await failed.service.depositAssetStatus(failed.input, ADDRESS)).canRetry).toBe(false);
    const absent = fixture(); delete (absent.onchain as Partial<typeof absent.onchain>).isMarginCommitmentRecordedAsync;
    expect((await absent.service.depositAssetStatus(absent.input, ADDRESS)).canRetry).toBe(false);
    const disabled = fixture(); disabled.onchain.enabled = false;
    expect((await disabled.service.depositAssetStatus(disabled.input, ADDRESS)).canRetry).toBe(false);
    const malformed = fixture(); malformed.onchain.isMarginCommitmentRecordedAsync = async () => undefined as never;
    expect((await malformed.service.depositAssetStatus(malformed.input, ADDRESS)).canRetry).toBe(false);
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.pending.finalizedAt = 1; },
      (f: ReturnType<typeof fixture>) => { f.pending.preparedTxHash = fieldHex(9n); },
      (f: ReturnType<typeof fixture>) => f.store.marginCommitments.add(f.input.commitment),
      (f: ReturnType<typeof fixture>) => f.store.pendingAssetDeposits.set(f.input.commitment, structuredClone(f.pending)),
    ]) {
      const f = fixture(); f.onRead(() => mutate(f));
      expect((await f.service.depositAssetStatus(f.input, ADDRESS)).canRetry).toBe(false);
    }
  });

  test("registers an authenticated GET without exposing proofs, witnesses or prepared envelopes", async () => {
    const f = fixture(); let authCalls = 0;
    const router = new Router({ protectMutations: true, authenticate: async () => { authCalls++; return { address: ADDRESS }; } });
    registerNotesRoute(router, { store: f.store } as never, {} as never, f.env as never, f.onchain as never);
    const response = await router.handle(new Request(`http://127.0.0.1/notes/deposit-asset/status?${new URLSearchParams(f.input)}`));
    expect(response.status).toBe(200); expect(authCalls).toBe(1);
    const body = await response.json(); expect(body.status.canRetry).toBe(true);
    expect(body.status.amount).toBe("100");
    for (const field of ["depositProof", "preparedXdr", "proof", "signedXdr"]) expect(JSON.stringify(body)).not.toContain(field);
  });
});
