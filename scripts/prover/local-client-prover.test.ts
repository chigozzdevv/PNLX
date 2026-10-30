import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentValidityRecord, ProofMeta } from "@pnlx/protocol-types";
import { createLocalClientProverHandler } from "./local-client-prover";

type TestProver = NonNullable<NonNullable<Parameters<typeof createLocalClientProverHandler>[1]>["prover"]>;

describe("hosted client proof scheduling", () => {
  test("runs two intent proofs, queues later work and serves health while both are pending", async () => {
    const fixture = harness();
    try {
      const timeouts: number[] = [];
      const runtime = { timeout: (_request: Request, seconds: number) => { timeouts.push(seconds); } };
      const requests = Array.from({ length: 4 }, (_, index) => fixture.handle(intentRequest(index), runtime));
      await until(() => fixture.calls.length === 2);
      expect(fixture.active()).toBe(2);
      const health = await fixture.handle(new Request("http://prover/health"), runtime);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, service: "pnlx-local-client-prover" });
      expect(fixture.calls).toHaveLength(2);
      expect(timeouts).toEqual([0, 0, 0, 0]);

      fixture.calls[0].resolve();
      await until(() => fixture.calls.length === 3);
      expect(fixture.active()).toBe(2);
      fixture.calls[1].resolve();
      await until(() => fixture.calls.length === 4);
      fixture.calls[2].resolve();
      fixture.calls[3].resolve();
      expect((await Promise.all(requests)).map((response) => response.status)).toEqual([200, 200, 200, 200]);
      expect(fixture.peak()).toBe(2);
    } finally { fixture.dispose(); }
  });

  test("rejects overload with retry backpressure and cancels queued disconnects before proving", async () => {
    const fixture = harness();
    try {
      const active = [fixture.handle(intentRequest(0)), fixture.handle(intentRequest(1))];
      await until(() => fixture.calls.length === 2);
      const controllers = Array.from({ length: 8 }, () => new AbortController());
      const queued = controllers.map((controller, index) => fixture.handle(intentRequest(index + 2, controller.signal)));
      await tick();
      const overloaded = await fixture.handle(intentRequest(10));
      expect(overloaded.status).toBe(503);
      expect(overloaded.headers.get("retry-after")).toBe("1");
      expect(overloaded.headers.get("access-control-allow-origin")).toBe("*");
      expect(await overloaded.json()).toEqual({ error: "Prover is busy. Try again shortly." });

      controllers.forEach((controller) => controller.abort());
      expect((await Promise.all(queued)).every((response) => response.status === 499)).toBe(true);
      expect(fixture.calls).toHaveLength(2);
      fixture.calls.forEach((call) => call.resolve());
      expect((await Promise.all(active)).every((response) => response.status === 200)).toBe(true);
    } finally { fixture.dispose(); }
  });

  test("releases a failed job's slot without returning private error details", async () => {
    const fixture = harness();
    try {
      const requests = Array.from({ length: 3 }, (_, index) => fixture.handle(intentRequest(index)));
      await until(() => fixture.calls.length === 2);
      fixture.calls[0].reject(new Error("SECRET-WITNESS-FIELD"));
      const failed = await requests[0];
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "Proof generation failed" });
      await until(() => fixture.calls.length === 3);
      fixture.calls[1].resolve();
      fixture.calls[2].resolve();
      expect((await Promise.all(requests.slice(1))).every((response) => response.status === 200)).toBe(true);
      expect(fixture.peak()).toBe(2);
    } finally { fixture.dispose(); }
  });

  test("keeps a disconnected active job reserved until its prover and cleanup finish", async () => {
    const fixture = harness();
    try {
      const controller = new AbortController();
      let disconnectedFinished = false;
      const disconnected = fixture.handle(intentRequest(0, controller.signal)).then((response) => {
        disconnectedFinished = true;
        return response;
      });
      const other = fixture.handle(intentRequest(1));
      const waiting = fixture.handle(intentRequest(2));
      await until(() => fixture.calls.length === 2);
      controller.abort();
      await tick();
      expect(disconnectedFinished).toBe(false);
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.active()).toBe(2);

      fixture.calls[0].resolve();
      expect((await disconnected).status).toBe(499);
      await until(() => fixture.calls.length === 3);
      fixture.calls[1].resolve();
      fixture.calls[2].resolve();
      expect((await other).status).toBe(200);
      expect((await waiting).status).toBe(200);
      expect(fixture.active()).toBe(0);
      expect(fixture.peak()).toBe(2);
    } finally { fixture.dispose(); }
  });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "pnlx-hosted-proof-"));
  const path = join(root, "public-proof-artifact");
  writeFileSync(path, "test-public-proof");
  const calls: Array<{ resolve(): void; reject(error: Error): void }> = [];
  let active = 0;
  let peak = 0;
  const proof: ProofMeta = { circuitId: "intent-validity", circuitKey: "0x1", circuitHash: "0x2",
    verifierHash: "0x3", publicInputHash: "0x4", proofDigest: "0x5" };
  const record: IntentValidityRecord = {
    assetDigest: "0x1", matchingPayloadCommitment: "0x2", ownerDigest: "0x3", positionSeed: "0x4",
    batchDigest: "0x5", currentBatch: 1n, expiryBatch: 2n, intentCommitment: "0x6", marketDigest: "0x7",
    noteChangeCommitment: "0x0", noteCommitment: "0x8", marginRoot: "0x9", noteNullifier: "0xa",
    ownerCommitmentField: "0xb", proof,
  };
  const unexpected = () => { throw new Error("Unexpected synchronous prover call"); };
  const prover: TestProver = {
    artifactFor: () => ({ bytecodeHash: "0x1", circuitId: "intent-validity", circuitKey: "0x1",
      proofHash: "0x5", proofPath: path, publicInputsHash: "0x4", publicInputsPath: path,
      vkHash: "0x3", vkPath: path, witnessHash: "0x6" }),
    proveDepositNote: unexpected, proveSecureDepositNote: unexpected, provePositionClose: unexpected,
    proveWithdrawal: unexpected, proveSecureWithdrawal: unexpected,
    proveIntentValidityAsync: async () => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve, reject) => calls.push({ resolve, reject }));
        return record;
      } finally { active -= 1; }
    },
  };
  return {
    handle: createLocalClientProverHandler(root, { prover }), calls,
    active: () => active, peak: () => peak,
    dispose: () => {
      calls.forEach((call) => call.resolve());
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function intentRequest(index: number, signal?: AbortSignal): Request {
  return new Request("http://prover/intent-validity", {
    method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetDigest: "0x1", batchId: `request-${index}`, blinding: "0x2",
      currentBatch: "1", expiryBatch: "2", limitPrice: "100", margin: "10", marginRoot: "0x3",
      marketId: "xlm-usd-perp", nonce: `nonce-${index}`, noteAmount: "10", noteCommitment: "0x4",
      noteNullifier: "0x5", owner: "GTEST", ownerDigest: "0x6", pathIndices: [], pathSiblings: [],
      rhoDigest: "0x7", salt: "test-salt", side: "long", size: "1", spendSecretDigest: "0x8" }),
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for prover jobs");
    await tick();
  }
}
