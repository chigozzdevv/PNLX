import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISSUER, MASTER, fundWallet, type WalletRecord } from "./wallets";

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const HASH = "a".repeat(64);
const SIGNED_XDR = "synthetic-signed-envelope-for-tests";
type Call = { args: string[]; stdin: string };

function account(usdc: string, xlm = "25.0000000") {
  return Response.json({ balances: [
    { asset_type: "native", balance: xlm },
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: usdc, is_authorized: true },
  ] });
}

/**
 * A fresh Bun process starts with the fake executable first on PATH. Changing
 * process.env.PATH in an existing Bun process does not reliably change its
 * child_process executable lookup; an isolated process also keeps fetch and
 * sleep stubs out of other tests.
 */
async function withHarness(run: (harness: {
  wallet: WalletRecord;
  calls: () => Call[];
  fetch: (handler: (url: string) => Response | Promise<Response>) => void;
}) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "pnlx-wallet-test-"));
  const log = join(directory, "calls.jsonl");
  const executable = join(directory, "stellar");
  const stub = join(directory, "stub.ts");
  const worker = join(directory, "worker.ts");
  writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${stub.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  writeFileSync(stub, `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const stdin = readFileSync(0, "utf8");
appendFileSync(process.env.PNLX_WALLET_TEST_LOG, JSON.stringify({ args, stdin }) + "\\n");
if (args[0] === "keys" && args[1] === "address") console.log(args[2] === "pnlx-observation-funder" ? ${JSON.stringify(MASTER)} : ${JSON.stringify(ADDRESS)});
else if (args[0] === "tx" && args[1] === "new") console.log("synthetic-unsigned-envelope-for-tests");
else if (args[0] === "tx" && args[1] === "sign") console.log(${JSON.stringify(SIGNED_XDR)});
else if (args[0] === "tx" && args[1] === "hash") console.log(${JSON.stringify(HASH)});
else if (args[0] === "tx" && args[1] === "send") { console.error("synthetic uncertain submission response"); process.exit(1); }
else process.exit(90);
`);
  writeFileSync(worker, `
import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fundWallet, ISSUER, MASTER } from ${JSON.stringify(new URL("./wallets.ts", import.meta.url).pathname)};
const ADDRESS = ${JSON.stringify(ADDRESS)};
const HASH = ${JSON.stringify(HASH)};
const SIGNED_XDR = ${JSON.stringify(SIGNED_XDR)};
if (Bun.which("stellar") !== ${JSON.stringify(executable)}) throw new Error("Test must resolve only the fake Stellar CLI");
const account = ${account.toString()};
const run = ${run.toString()};
const originalFetch = globalThis.fetch;
Bun.sleep = () => Promise.resolve();
const calls = () => {
  try { return readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
};
await run({
  wallet: { source: "pnlx-observation-test-wallet", address: ADDRESS, funding: [] }, calls,
  fetch(handler) {
    globalThis.fetch = Object.assign((url) => Promise.resolve(handler(String(url))), { preconnect: originalFetch.preconnect });
  },
});
`);
  try {
    const result = spawnSync(process.execPath, [worker], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, PNLX_WALLET_TEST_LOG: log },
    });
    if (result.status !== 0) throw new Error(`Isolated wallet guard test failed: ${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("observation wallet funding recovery", () => {
  test("persists the exact signed envelope and hash before the first submit", async () => {
    await withHarness(async ({ wallet, calls, fetch }) => {
      const checkpoints: WalletRecord[] = [];
      let submitted = false;
      fetch((url) => {
        if (url.endsWith(`/accounts/${ADDRESS}`)) return account("0");
        if (url.endsWith(`/accounts/${MASTER}`)) return account("1000");
        if (url.endsWith(`/transactions/${HASH}`)) {
          const sends = calls().filter((call) => call.args[0] === "tx" && call.args[1] === "send");
          if (!sends.length) {
            expect(checkpoints).toHaveLength(1);
            expect(checkpoints[0]!.funding[0]!.signedXdr).toBe(SIGNED_XDR);
            expect(checkpoints[0]!.funding[0]!.hash).toBe(HASH);
            return new Response(null, { status: 404 });
          }
          submitted = true;
          expect(sends).toHaveLength(1);
          expect(sends[0]!.stdin).toBe(checkpoints[0]!.funding[0]!.signedXdr);
          return Response.json({ successful: true, created_at: "2026-10-30T10:00:00Z" });
        }
        throw new Error(`Unexpected test request: ${url}`);
      });
      await fundWallet(wallet, async () => { checkpoints.push(structuredClone(wallet)); });
      expect(submitted).toBe(true);
      expect(wallet.funding).toHaveLength(1);
      expect(wallet.funding[0]!.confirmedAt).toBe(Date.parse("2026-10-30T10:00:00Z"));
      expect(checkpoints).toHaveLength(2);
      const payment = calls().find((call) => call.args.includes("payment"));
      expect(payment!.args).toContain("2500000000");
      expect(payment!.args).toContain(`USDC:${ISSUER}`);
      expect(calls().find((call) => call.args[1] === "hash")!.stdin).toBe(SIGNED_XDR);
    });
  });

  test("does not submit when durable preparation fails", async () => {
    await withHarness(async ({ wallet, calls, fetch }) => {
      fetch((url) => url.endsWith(`/accounts/${MASTER}`) ? account("1000") : account("0"));
      await expect(fundWallet(wallet, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
      expect(wallet.funding).toHaveLength(1);
      expect(wallet.funding[0]!.signedXdr).toBe(SIGNED_XDR);
      expect(calls().some((call) => call.args[0] === "tx" && call.args[1] === "send")).toBe(false);
    });
  });

  test("reconciles the saved transaction before balances or any replacement funding", async () => {
    await withHarness(async ({ wallet, calls, fetch }) => {
      wallet.funding.push({ id: "persisted-action", hash: HASH, signedXdr: SIGNED_XDR, preparedAt: 1 });
      const requests: string[] = [];
      let persisted = 0;
      fetch((url) => {
        requests.push(url);
        if (url.endsWith(`/transactions/${HASH}`)) return Response.json({ successful: true, created_at: "2026-10-30T10:00:00Z" });
        if (url.endsWith(`/accounts/${ADDRESS}`)) return account("250");
        throw new Error(`Unexpected test request: ${url}`);
      });
      await fundWallet(wallet, async () => { persisted += 1; });
      expect(requests[0]).toEndWith(`/transactions/${HASH}`);
      expect(persisted).toBe(1);
      expect(wallet.funding).toHaveLength(1);
      expect(calls().some((call) => call.args[0] === "tx")).toBe(false);
    });
  });

  test("halts without further funding when a saved transaction failed on chain", async () => {
    await withHarness(async ({ wallet, calls, fetch }) => {
      wallet.funding.push({ id: "failed-action", hash: HASH, signedXdr: SIGNED_XDR, preparedAt: 1 });
      let requests = 0;
      fetch(() => { requests += 1; return Response.json({ successful: false, created_at: "2026-10-30T10:00:00Z" }); });
      await expect(fundWallet(wallet, async () => {})).rejects.toThrow("failed on chain");
      expect(requests).toBe(1);
      expect(wallet.funding[0]!.confirmedAt).toBeUndefined();
      expect(calls().some((call) => call.args[0] === "tx")).toBe(false);
    });
  });

  test("does not replay or create funding while Horizon cannot reconcile the known hash", async () => {
    await withHarness(async ({ wallet, calls, fetch }) => {
      wallet.funding.push({ id: "uncertain-action", hash: HASH, signedXdr: SIGNED_XDR, preparedAt: 1 });
      fetch(() => new Response(null, { status: 503 }));
      await expect(fundWallet(wallet, async () => {})).rejects.toThrow("reconciliation unavailable");
      expect(wallet.funding).toHaveLength(1);
      expect(calls().some((call) => call.args[0] === "tx")).toBe(false);
    });
  });

  test("an unconfirmed submission replays only its saved envelope and blocks all new funding", async () => {
    await withHarness(async ({ wallet, calls, fetch }) => {
      wallet.funding.push({ id: "uncertain-action", hash: HASH, signedXdr: SIGNED_XDR, preparedAt: 1 });
      const requests: string[] = [];
      fetch((url) => { requests.push(url); return new Response(null, { status: 404 }); });
      await expect(fundWallet(wallet, async () => {})).rejects.toThrow("confirmation pending");
      const txCalls = calls().filter((call) => call.args[0] === "tx");
      expect(txCalls).toHaveLength(1);
      expect(txCalls[0]!.args[1]).toBe("send");
      expect(txCalls[0]!.stdin).toBe(SIGNED_XDR);
      expect(requests).toHaveLength(20);
      expect(requests.every((url) => url.endsWith(`/transactions/${HASH}`))).toBe(true);
      expect(wallet.funding).toHaveLength(1);
    });
  });
});
