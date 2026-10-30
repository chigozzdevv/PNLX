import { describe, expect, test } from "bun:test";
import { fieldHex, ownerCommitment } from "@pnlx/crypto";
import type { Hex, PairedPositionCloseRecord } from "@pnlx/protocol-types";
import { PositionClosesService } from "./position-closes.service";
import { registerPositionClosesRoute } from "./position-closes.route";
import { parsePositionCloseStatus } from "./position-closes.schema";
import { ProtocolStore } from "@/shared/state/store";
import { Router } from "@/shared/http/router";
import type { PendingPairedClose } from "@/shared/protocol/paired-close-journal";

const ADDRESS = "GCXW7ZMGSP4RK4LQHO2GMNT4DC4PKEFOQIL5U3ET6HREGJYPENQLQ7RH";
const OWNER = ownerCommitment(ADDRESS);
const OTHER = "GCLGNRTRKZ3GND4T64HHMOQZLEIWNJJ2JEQH6WHXUKLOIMJT7OXWBVBI";

function fixture() {
  const store = new ProtocolStore();
  const proof = { circuitId: "position-close-pair", circuitKey: fieldHex(100n), circuitHash: fieldHex(1n),
    verifierHash: fieldHex(2n), publicInputHash: fieldHex(3n), proofDigest: fieldHex(4n) };
  const legs = [0, 1].map((index) => ({ marketId: "xlm-usd-perp", markPrice: 100n, currentFundingIndex: 0n,
    positionRoot: fieldHex(5n), positionCommitment: fieldHex(BigInt(6 + index)), positionNullifier: fieldHex(BigInt(8 + index)),
    closeCommitment: fieldHex(BigInt(10 + index)), newPositionCommitment: fieldHex(BigInt(12 + index)),
    marginOutputCommitment: fieldHex(BigInt(14 + index)), proof })) as PairedPositionCloseRecord["positions"];
  const outputNote = (index: 0 | 1) => ({ ownerCommitment: index ? ownerCommitment(OTHER) : OWNER,
    commitment: legs[index].marginOutputCommitment, closeCommitment: legs[index].closeCommitment,
    closePositionCommitment: legs[index].positionCommitment });
  const run: PendingPairedClose = { journalKey: legs[0].closeCommitment,
    pair: { marketId: "xlm-usd-perp", assetDigest: fieldHex(20n), markPrice: 100n, currentFundingIndex: 0n,
      maintenanceRate: 100_000n, liquidation: false, positionRoot: fieldHex(5n), positions: legs, proof },
    outputNotes: [outputNote(0), outputNote(1)],
    conditional: false, createdAt: 1, retired: true, retiredReason: "confirmed failed submission",
    settlementTxHash: fieldHex(30n), preparedXdr: "retained-signed-envelope" };
  for (const [index, leg] of legs.entries()) store.positionLifecycle.set(leg.positionCommitment, {
    batchId: "fixture", marketId: leg.marketId, ownerCommitment: index ? ownerCommitment(OTHER) : OWNER,
    positionCommitment: leg.positionCommitment, positionNullifier: leg.positionNullifier,
    sourceIntentCommitment: fieldHex(41n), settlementDigest: fieldHex(42n), status: "open", openedAt: 1, updatedAt: 1,
  });
  store.pendingPairedCloses.set(run.journalKey, run);
  const reads: string[] = [];
  let tx: "FAILED" | "SUCCESS" | "NOT_FOUND" = "FAILED";
  let settled = [false, false], spent = [false, false], failReads = false;
  let onRead: (() => void) | undefined;
  const onchain = { enabled: true,
    async positionPairTransactionStatus(hash: Hex) {
      reads.push(`transaction:${hash}`); if (failReads) throw new Error("RPC unavailable");
      onRead?.(); return tx;
    },
    async isPositionCloseSettledAsync(close: Hex) { reads.push(`close:${close}`); return settled[legs.findIndex((leg) => leg.closeCommitment === close)]!; },
    async isPositionSpentAsync(nullifier: Hex) { reads.push(`spent:${nullifier}`); return spent[legs.findIndex((leg) => leg.positionNullifier === nullifier)]!; },
  };
  const service = new PositionClosesService({ store } as never, {} as never, onchain as never,
    { settlementsOnchainRequired: true, authRequired: true });
  const input = { ownerCommitment: OWNER, positionCommitment: legs[0].positionCommitment, closeCommitment: legs[0].closeCommitment };
  return { store, run, legs, service, input, reads, onchain,
    transaction(value: typeof tx) { tx = value; }, settlement(value: boolean[]) { settled = value; },
    spending(value: boolean[]) { spent = value; }, failReads() { failReads = true; }, onRead(value: () => void) { onRead = value; } };
}

describe("owner-bound close recovery status", () => {
  test("permits only the exact retired failed transaction with both unspent positions and preserves the journal", async () => {
    const f = fixture(); const before = JSON.stringify(f.run, (_, value) => typeof value === "bigint" ? value.toString() : value);
    const result = await f.service.status(f.input, ADDRESS);
    expect(result).toEqual({ ...f.input, marginOutputCommitment: f.legs[0].marginOutputCommitment,
      settlementTxHash: f.run.settlementTxHash, transactionStatus: "FAILED", canRetry: true });
    expect(f.reads).toHaveLength(5);
    expect(JSON.stringify(f.run, (_, value) => typeof value === "bigint" ? value.toString() : value)).toBe(before);
    expect(f.store.positionCloses.size).toBe(0);
  });

  test("unknown, successful, settled or spent outcomes never allow replacement", async () => {
    for (const tx of ["NOT_FOUND", "SUCCESS"] as const) {
      const f = fixture(); f.transaction(tx); expect((await f.service.status(f.input, ADDRESS)).canRetry).toBe(false);
    }
    for (const flags of [[true, false], [false, true], [true, true]]) {
      const settled = fixture(); settled.settlement(flags);
      expect((await settled.service.status(settled.input, ADDRESS)).canRetry).toBe(false);
      const spent = fixture(); spent.spending(flags);
      expect((await spent.service.status(spent.input, ADDRESS)).canRetry).toBe(false);
    }
  });

  test("RPC failures and missing authoritative readers fail closed", async () => {
    const failure = fixture(); failure.failReads();
    expect((await failure.service.status(failure.input, ADDRESS)).canRetry).toBe(false);
    const missing = fixture(); delete (missing.onchain as Partial<typeof missing.onchain>).isPositionSpentAsync;
    expect((await missing.service.status(missing.input, ADDRESS)).canRetry).toBe(false);
    const disabled = fixture(); disabled.onchain.enabled = false;
    expect((await disabled.service.status(disabled.input, ADDRESS)).canRetry).toBe(false);
  });

  test("active, winning, missing or incorrectly bound journals fail closed", async () => {
    const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => { f.run.retired = false; }, (f) => { f.run.retiredReconciled = true; },
      (f) => { delete f.run.settlementTxHash; }, (f) => { f.store.pendingPairedCloses.clear(); },
      (f) => { f.run.outputNotes[0].commitment = fieldHex(99n); },
      (f) => { f.run.outputNotes[0].ownerCommitment = ownerCommitment(OTHER); },
      (f) => { f.run.pair.positions[0].positionNullifier = fieldHex(99n); },
      (f) => { f.run.pair.positions[0].closeCommitment = fieldHex(99n); },
    ];
    for (const mutate of mutations) {
      const f = fixture(); mutate(f); expect((await f.service.status(f.input, ADDRESS)).canRetry).toBe(false);
    }
  });

  test("rechecks position lifecycle, competing journals and retirement after the network reads", async () => {
    for (const index of [0, 1]) {
      const closed = fixture(); closed.onRead(() => { closed.store.positionLifecycle.get(closed.legs[index]!.positionCommitment)!.status = "closed"; });
      expect((await closed.service.status(closed.input, ADDRESS)).canRetry).toBe(false);
      const competing = fixture(); competing.onRead(() => {
        const other = structuredClone(competing.run); other.journalKey = fieldHex(70n); other.retired = false;
        other.pair.positions[0].positionCommitment = competing.legs[index]!.positionCommitment;
        competing.store.pendingPairedCloses.set(other.journalKey, other);
      });
      expect((await competing.service.status(competing.input, ADDRESS)).canRetry).toBe(false);
    }
    const changed = fixture(); changed.onRead(() => { changed.run.retired = false; });
    expect((await changed.service.status(changed.input, ADDRESS)).canRetry).toBe(false);
  });

  test("requires authenticated ownership before reading the transaction", async () => {
    const f = fixture();
    await expect(f.service.status(f.input)).rejects.toThrow("authenticated owner");
    await expect(f.service.status(f.input, OTHER)).rejects.toThrow("authenticated account");
    expect(f.reads).toHaveLength(0);
    const wrongPosition = { ...f.input, positionCommitment: f.legs[1].positionCommitment };
    await expect(f.service.status(wrongPosition, ADDRESS)).rejects.toThrow("position not found");
    expect(f.reads).toHaveLength(0);
  });

  test("validates query commitments and registers an authenticated GET response without private records", async () => {
    const f = fixture(); const params = new URLSearchParams(f.input);
    const url = `http://127.0.0.1/position-closes/status?${params}`;
    expect(parsePositionCloseStatus(new Request(url))).toEqual(f.input);
    expect(() => parsePositionCloseStatus(new Request("http://127.0.0.1/position-closes/status?ownerCommitment=0x1"))).toThrow("32-byte");
    let authCalls = 0;
    const router = new Router({ protectMutations: true, authenticate: async () => { authCalls++; return { address: ADDRESS }; } });
    registerPositionClosesRoute(router, { store: f.store } as never, {} as never,
      { settlementsOnchainRequired: true, authRequired: true } as never, f.onchain as never);
    const response = await router.handle(new Request(url));
    expect(response.status).toBe(200); expect(authCalls).toBe(1);
    const json = await response.json(); expect(json.status.canRetry).toBe(true);
    const text = JSON.stringify(json);
    expect(text).not.toContain("preparedXdr"); expect(text).not.toContain("outputNotes");
    expect(text).not.toContain(f.legs[1].positionCommitment); expect(text).not.toContain(f.legs[1].closeCommitment);
  });
});
