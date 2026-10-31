import { expect, test } from "bun:test";
import { fieldHex, secureMarginRoot } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import { resolve } from "node:path";
import type { ServerEnv } from "@/config/env";
import { StellarConfirmedDepositRecovery } from "@/features/notes/confirmed-deposit-recovery";
import type { CommandResult } from "@/workers/relayer/relayer.model";

test("confirmed deposit recovery reads a full note tree concurrently and keeps leaf order", async () => {
  const leaves = Array.from({ length: 105 }, (_, index) => fieldHex(BigInt(index + 1)));
  const commitment = leaves.at(-1)!;
  const txHash = fieldHex(500n);
  const tokenDigest = fieldHex(501n);
  const networkPassphrase = "Test SDF Network ; September 2015";
  let activeReads = 0;
  let maxActiveReads = 0;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    const result = request.method === "getNetwork"
      ? { passphrase: networkPassphrase }
      : { status: "SUCCESS", ledger: 7, envelopeXdr: "YWJj" };
    return Response.json({ result });
  }) as unknown as typeof fetch;
  const command = async (args: string[]): Promise<CommandResult> => {
    const separator = args.indexOf("--");
    const method = args[separator + 1];
    let stdout: string;
    if (args[1] === "tx" && args[2] === "hash") stdout = txHash;
    else if (method === "token_digest") stdout = tokenDigest;
    else if (method === "has_commitment") stdout = "true";
    else if (method === "secure_note_root") stdout = secureMarginRoot(leaves);
    else if (method === "secure_note_count") stdout = String(leaves.length);
    else if (method === "secure_note_leaf") {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await Promise.resolve();
      const index = Number(args[args.indexOf("--index") + 1]);
      stdout = leaves[index]!;
      activeReads -= 1;
    } else throw new Error("unexpected recovery command");
    return { status: 0, stdout: args[1] === "tx" || method === "has_commitment" || method === "secure_note_count"
      ? stdout : JSON.stringify(stdout), stderr: "" };
  };
  const env = {
    stellarOnchainRelay: true,
    stellarRelayerMode: "stellar-cli",
    stellarDeploymentFile: resolve(import.meta.dir, "../../../../deployments/testnet.json"),
    stellarNetwork: "testnet",
    stellarNetworkPassphrase: networkPassphrase,
    stellarRpcUrl: "https://soroban-testnet.stellar.org/",
    stellarCommandTimeoutMs: 10_000,
    stellarSource: "pnlx-testnet",
  } as ServerEnv;
  const pending = {
    amount: 100n,
    commitment,
    from: "GCXW7ZMGSP4RK4LQHO2GMNT4DC4PKEFOQIL5U3ET6HREGJYPENQLQ7RH",
    token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    tokenDigest,
    preparedTxHash: txHash,
    preparedXdrDigest: fieldHex(502n),
    createdAt: 1,
    depositProof: {} as never,
  };

  const result = await new StellarConfirmedDepositRecovery(env, fetcher, command).read(pending, []);

  expect(result.commitments).toEqual(leaves);
  expect(result.commitments).toContain(commitment as Hex);
  expect(maxActiveReads).toBeGreaterThan(1);
  expect(maxActiveReads).toBeLessThanOrEqual(10);
});
