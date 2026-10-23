import { describe, expect, test } from "bun:test";
import { RelayerService } from "@/workers/relayer/relayer.service";
import type { CommandResult, RelayRequest } from "@/workers/relayer/relayer.model";

const hash = "0xf0c56f355ef705f235bd2165522ba93dfc5e2c89c7ac34b648fd9e77c55d0ebc" as const;
const other = `0x${"b".repeat(64)}`;
const config = { mode: "stellar-cli" as const, network: "parser-testnet", source: "parser-source" };
const request: RelayRequest = { kind: "contract-invoke", payload: {
  contractId: "proof-verifier", functionName: "verify_and_record", send: "yes",
} };
const output = (stdout: string, stderr = ""): CommandResult => ({ status: 0, stdout, stderr });
const cli27 = (signing: string = hash, explorer: string = signing) => output("null\n", [
  "ℹ️ Simulating transaction…",
  `ℹ️ Signing transaction: ${signing.replace(/^0x/, "")}`,
  "🌎 Sending transaction…",
  "✅ Transaction submitted successfully!",
  `🔗 https://stellar.expert/explorer/testnet/tx/${explorer.replace(/^0x/, "")}`,
].join("\n") + "\n");
const txSend27 = () => output(JSON.stringify({ v1: { tx: {
  source_account: "source-account",
  operations: [{ body: { invoke_host_function: { host_function: { invoke_contract: {
    contract_address: "proof-verifier", function_name: "verify_and_record", args: [],
  } }, auth: [] } } }],
  ext: { resources: { footprint: { read_only: [
    { contract_code: { hash: other.slice(2) } },
    { contract_code: { hash: "c".repeat(64) } },
  ], read_write: [] } } },
}, signatures: [] } }), `ℹ️ Transaction hash is ${hash.slice(2)}\nhttps://stellar.expert/explorer/testnet/tx/${hash.slice(2)}\n`);

describe("unambiguous Stellar transaction hashes", () => {
  for (const asynchronous of [false, true]) {
    const mode = asynchronous ? "async" : "sync";
    const relay = async (result: CommandResult) => {
      let calls = 0;
      const runner = () => { calls += 1; return result; };
      const service = asynchronous
        ? new RelayerService(config, undefined, async () => runner())
        : new RelayerService(config, runner);
      const run = async () => asynchronous ? service.relayAsync(request) : service.relay(request);
      return { run, calls: () => calls };
    };

    test(`${mode} accepts the actual CLI27 null stdout and emoji signing/explorer stderr`, async () => {
      const service = await relay(cli27());
      expect(await service.run()).toMatchObject({ submitted: true, txHash: hash });
      expect(service.calls()).toBe(1);
    });

    test(`${mode} ignores contract-code footprint hashes in CLI27 transaction-envelope stdout`, async () => {
      const service = await relay(txSend27());
      expect(await service.run()).toMatchObject({ submitted: true, txHash: hash });
      expect(service.calls()).toBe(1);
    });

    test(`${mode} accepts generic hash only at the result root or known transaction wrappers`, async () => {
      for (const value of [{ hash }, { result: { hash } }, { response: { transaction: { hash } } }]) {
        const service = await relay(output(JSON.stringify(value)));
        expect((await service.run()).txHash).toBe(hash);
      }
      const envelope = txSend27();
      const conflicting = JSON.parse(envelope.stdout);
      conflicting.v1.tx.transactionHash = other;
      const service = await relay(output(JSON.stringify(conflicting), envelope.stderr));
      await expect(service.run()).rejects.toThrow("did not return a transaction hash");
      expect(service.calls()).toBe(1);
    });

    test(`${mode} normalizes identical explicit hashes across JSON, labels and both streams`, async () => {
      const service = await relay(output(JSON.stringify({ result: { txHash: hash.toUpperCase() } }), [
        `Transaction hash is ${hash.slice(2)}`,
        `ℹ️ Signing transaction: ${hash}`,
        `🔗 https://stellar.expert/explorer/testnet/tx/${hash.slice(2)}`,
      ].join("\n")));
      expect((await service.run()).txHash).toBe(hash);
    });

    test(`${mode} accepts a quoted or numeric-only hash line surrounded by progress`, async () => {
      for (const value of [hash, `0x${"1".repeat(64)}`] as const) {
        const service = await relay(output(`"${value}"\n`, "ℹ️ Transaction submitted successfully!\n"));
        expect((await service.run()).txHash).toBe(value);
        const bare = await relay(output("", `ℹ️ Transaction submitted successfully!\n${value.slice(2)}\n`));
        expect((await bare.run()).txHash).toBe(value);
      }
    });

    test(`${mode} rejects conflicting signing, explorer, JSON or anchored-line hashes without retry`, async () => {
      for (const result of [
        cli27(hash, other),
        output(JSON.stringify({ txHash: hash, transaction_hash: other })),
        output(hash, `Transaction hash: ${other}`),
        output("", `Signing transaction: ${hash}\nSigning transaction: ${other}`),
      ]) {
        const service = await relay(result);
        await expect(service.run()).rejects.toThrow("did not return a transaction hash");
        expect(service.calls()).toBe(1);
      }
    });

    test(`${mode} ignores unrelated proof digests, arbitrary text and foreign explorer links`, async () => {
      for (const result of [
        output(JSON.stringify({ proofDigest: hash, vkHash: hash })),
        output(JSON.stringify([hash], null, 2), "ℹ️ Simulation complete\n"),
        output(JSON.stringify({ footprint: { contract_code: { hash } } })),
        output(`ℹ️ Simulation complete\n  "hash": "${hash}",\n`),
        output(`arbitrary proof bytes ${hash}`),
        output("null", `🔗 https://stellar.expert/explorer/testnet/tx/${hash.slice(2)}`),
        output(txSend27().stdout, `https://stellar.expert/explorer/testnet/tx/${hash.slice(2)}\n`),
        output("null", `🔗 https://stellar.expert.evil.test/explorer/testnet/tx/${hash.slice(2)}`),
      ]) {
        const service = await relay(result);
        await expect(service.run()).rejects.toThrow("did not return a transaction hash");
        expect(service.calls()).toBe(1);
      }
    });

    test(`${mode} does not turn a failed command with a signing hash into a successful relay`, async () => {
      const service = await relay({ ...cli27(), status: 1 });
      await expect(service.run()).rejects.toThrow("stellar relay failed");
      expect(service.calls()).toBe(1);
    });
  }

  test("signed envelope submission accepts CLI27 envelope stdout only for its precomputed exact hash", () => {
    let sends = 0;
    const service = new RelayerService(config, (_program, args) => {
      if (args[1] === "hash") return output(`"${hash}"`, "ℹ️ Hashing transaction\n");
      sends += 1;
      return txSend27();
    });
    expect(service.submitSignedXdr({ xdr: "signed-envelope", expectedTxHash: hash })).toMatchObject({ submitted: true, txHash: hash });
    expect(sends).toBe(1);
  });

  test("journaled relay persists before send and retains the exact hash after conflicting output", async () => {
    const xdrs = { built: "Q".repeat(32), assembled: "R".repeat(32), signed: "S".repeat(32) };
    let saved: { txHash: `0x${string}`; xdr: string } | undefined;
    let conflicting = true;
    const commands: string[] = [];
    const service = new RelayerService(config, undefined, async (_program, args) => {
      commands.push(args[1]!);
      if (args.includes("--build-only")) return output(xdrs.built);
      if (args[1] === "simulate") return output(xdrs.assembled);
      if (args[1] === "sign") return output(xdrs.signed);
      if (args[1] === "hash") return output(`"${hash}"`, "ℹ️ Hashing transaction\n");
      expect(saved).toEqual({ txHash: hash, xdr: xdrs.signed });
      return conflicting ? cli27(hash, other) : txSend27();
    });
    let failure: unknown;
    try { await service.relayJournaled(request, async prepared => { saved = prepared; }); }
    catch (error) { failure = error; }
    expect((failure as { txHash: string }).txHash).toBe(hash);
    expect(commands.filter(command => command === "send")).toHaveLength(1);
    expect(saved).toEqual({ txHash: hash, xdr: xdrs.signed });
    conflicting = false;
    commands.length = 0;
    expect(await service.relayJournaled(request, async () => {}, saved!)).toMatchObject({ submitted: true, txHash: hash });
    expect(commands).toEqual(["hash", "send"]);
  });
});
