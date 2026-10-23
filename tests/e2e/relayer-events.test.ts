import { describe, expect, test } from "bun:test";
import { OnchainRelayService } from "@/workers/onchain/onchain.service";
import { RelayerService } from "@/workers/relayer/relayer.service";

const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const commitment = `0x${"01".repeat(32)}` as const;
const transaction = "ab".repeat(32);
const topic0 = Buffer.from("0000000f0000000970616972636c6f7365000000", "hex").toString("base64");
const topic1 = Buffer.from(`0000000d00000020${"01".repeat(32)}`, "hex").toString("base64");
const event = () => ({ type: "contract", contractId, ledger: 123, topic: [topic0, topic1], txHash: transaction });
const service = () => new RelayerService({ mode: "stellar-cli", network: "testnet", source: "source",
  rpcUrl: "https://rpc.test", commandTimeoutMs: 10 });

async function rpcResponse(events: unknown[], work: (relay: RelayerService) => Promise<void>, extra = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ result: { oldestLedger: 1, latestLedger: 200, events, ...extra } })) as unknown as typeof fetch;
  try { await work(service()); }
  finally { globalThis.fetch = original; }
}

describe("authoritative close event transaction lookup", () => {
  test("queries exactly one ledger and verifies canonical contract event topics", async () => {
    const original = globalThis.fetch;
    let request: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return Response.json({ result: { oldestLedger: 1, latestLedger: 200, events: [event()] } });
    }) as unknown as typeof fetch;
    try {
      expect(await service().findContractEventTransaction(contractId, 123, commitment)).toBe(`0x${transaction}`);
      expect(request).toMatchObject({ method: "getEvents", params: {
        startLedger: 123, endLedger: 124, xdrFormat: "base64",
        filters: [{ type: "contract", contractIds: [contractId], topics: [[topic0, topic1]] }],
      } });
    } finally { globalThis.fetch = original; }
  });

  test("never accepts an event from another contract, ledger, topic, or failed call", async () => {
    for (const invalid of [
      { ...event(), contractId: "COTHER" }, { ...event(), ledger: 124 },
      { ...event(), topic: [topic0, "wrong"] }, { ...event(), topic: ["wrong", topic1] },
      { ...event(), inSuccessfulContractCall: false },
    ]) await rpcResponse([invalid], async (relay) => {
      await expect(relay.findContractEventTransaction(contractId, 123, commitment)).rejects.toThrow("not found uniquely");
    });
  });

  test("rejects ambiguous transaction evidence and missing transaction hashes", async () => {
    await rpcResponse([event(), { ...event(), txHash: "cd".repeat(32) }], async (relay) => {
      await expect(relay.findContractEventTransaction(contractId, 123, commitment)).rejects.toThrow("not found uniquely");
    });
    await rpcResponse([{ ...event(), txHash: undefined }], async (relay) => {
      await expect(relay.findContractEventTransaction(contractId, 123, commitment)).rejects.toThrow("valid transaction hash");
    });
  });

  test("fails closed outside retained history or on an incomplete result", async () => {
    await rpcResponse([event()], async (relay) => {
      await expect(relay.findContractEventTransaction(contractId, 123, commitment)).rejects.toThrow("outside retained");
    }, { oldestLedger: 124 });
    await rpcResponse(Array.from({ length: 1000 }, event), async (relay) => {
      await expect(relay.findContractEventTransaction(contractId, 123, commitment)).rejects.toThrow("incomplete");
    });
  });

  test("a stalled event response body hits the shared RPC deadline", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch;
    try {
      await expect(service().findContractEventTransaction(contractId, 123, commitment)).rejects.toThrow("deadline exceeded");
    } finally { globalThis.fetch = original; }
  });
});

describe("authoritative batch append metadata", () => {
  test("reads the exact settlement and parses CLI stdout independently of stderr", async () => {
    const reads: unknown[] = [];
    const relay = new OnchainRelayService({ async readAsync(request: unknown) {
      reads.push(request); return { output: "informational stderr must not be parsed", stdout: '{"first_position_index":"12"}' };
    } } as never, { enabled: true, deployment: { contracts: { "batch-settlement": contractId } } } as never);
    expect(await relay.batchPositionAppendIndexAsync("batch", "market")).toBe(12);
    expect(reads[0]).toMatchObject({ kind: "batch-settlement", payload: {
      contractId, functionName: "settlement_meta", send: "no",
    } });
  });

  test("fails closed on missing, negative, fractional, or malformed append indices", async () => {
    for (const stdout of ["null", "{}", '{"first_position_index":-1}', '{"first_position_index":1.5}',
      '{"first_position_index":"not-an-index"}', '{"first_position_index":4294967296}']) {
      const relay = new OnchainRelayService({ async readAsync() { return { stdout }; } } as never,
        { enabled: true, deployment: { contracts: { "batch-settlement": contractId } } } as never);
      await expect(relay.batchPositionAppendIndexAsync("batch", "market")).rejects.toThrow();
    }
  });
});

describe("authoritative batch settlement status", () => {
  function relayFor(stdout: string | undefined, output = "stderr mentions true") {
    const read = () => ({ stdout, output });
    return new OnchainRelayService({ read, readAsync: async () => read() } as never,
      { enabled: true, deployment: { contracts: { "batch-settlement": contractId } } } as never);
  }

  test("accepts only the returned boolean independently of diagnostic text", async () => {
    for (const value of [true, false]) {
      const relay = relayFor(` ${value}\n`, `diagnostic mentions ${!value}`);
      expect(relay.isBatchSettled("batch", "market", commitment)).toBe(value);
      expect(await relay.isBatchSettledAsync("batch", "market", commitment)).toBe(value);
    }
  });

  test("fails closed on missing stdout, malformed output and non-boolean JSON", async () => {
    for (const stdout of [undefined, "", "not true", '"true"', '"true', "true\nfalse",
      '{"settled":true}', "1", "null", "[true]"]) {
      const relay = relayFor(stdout, "true");
      expect(() => relay.isBatchSettled("batch", "market", commitment)).toThrow("invalid batch settlement status");
      await expect(relay.isBatchSettledAsync("batch", "market", commitment)).rejects.toThrow("invalid batch settlement status");
    }
  });
});
