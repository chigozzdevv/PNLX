import { describe, expect, test } from "bun:test";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";
import type { RelayerService } from "@/workers/relayer/relayer.service";

const OWNER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const VAULT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const ASSET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

const deployment: DeploymentRegistry = {
  contracts: { "liquidity-vault": VAULT },
  network: "testnet",
  source: "pnlx-testnet",
  sourceAddress: OWNER,
  verifiers: {},
};

describe("liquidity vault backend", () => {
  test("reports liquid assets separately from capital deployed at cost", async () => {
    const outputs: Record<string, string> = {
      asset: JSON.stringify(ASSET),
      operator: JSON.stringify(OWNER),
      maker: JSON.stringify(OWNER),
      paused: "true",
      liquid_assets: "20000000",
      deployed_principal: "80000000",
      total_shares: "9007199254740993",
      allocation_limit_bps: "8000",
    };
    const relayer = {
      readAsync: async (request: { payload: { functionName: string } }) => ({
        output: outputs[request.payload.functionName],
      }),
    } as unknown as Pick<RelayerService, "readAsync" | "prepareXdr">;
    const status = await new LiquidityVaultService(relayer, deployment).status();
    expect(status.liquidAssets).toBe("20000000");
    expect(status.deployedPrincipal).toBe("80000000");
    expect(status.totalAssetsAtCost).toBe("100000000");
    expect(status.totalShares).toBe("9007199254740993");
    expect(status.reconciledAssets).toBeNull();
    expect(status.withdrawalsOpen).toBe(false);
  });

  test("only reports redeemable equity after all allocations settle", async () => {
    const outputs: Record<string, string> = {
      shares: "1000",
      pending_shares: "500",
      available_shares: "500",
      deposited: "1000",
      withdrawn: "0",
      deployed_principal: "0",
      equity: "1100",
    };
    const relayer = {
      readAsync: async (request: { payload: { functionName: string } }) => ({
        output: outputs[request.payload.functionName],
      }),
    } as unknown as Pick<RelayerService, "readAsync" | "prepareXdr">;
    const vault = new LiquidityVaultService(relayer, deployment);
    expect((await vault.account(OWNER)).equity).toBe("1100");
    outputs.deployed_principal = "100";
    expect((await vault.account(OWNER)).equity).toBeNull();
  });

  test("prepares owner-signed deposits and withdrawals without submitting them", () => {
    const requests: unknown[] = [];
    const relayer = {
      prepareXdr: (request: unknown) => {
        requests.push(request);
        return { xdr: "signed-by-wallet-later", txHash: "0x1234" };
      },
    } as unknown as Pick<RelayerService, "readAsync" | "prepareXdr">;
    const vault = new LiquidityVaultService(relayer, deployment);
    vault.prepare(OWNER, { action: "deposit", amount: "10000000", minShares: "10000000" });
    vault.prepare(OWNER, { action: "request-withdraw", shares: "5000000" });
    expect(requests).toEqual([
      {
        kind: "contract-invoke",
        payload: {
          args: ["--from", OWNER, "--amount", "10000000", "--min_shares", "10000000"],
          buildOnly: true,
          contractId: VAULT,
          functionName: "deposit",
          send: "no",
          source: OWNER,
        },
      },
      {
        kind: "contract-invoke",
        payload: {
          args: ["--owner", OWNER, "--shares", "5000000"],
          buildOnly: true,
          contractId: VAULT,
          functionName: "request_withdraw",
          send: "no",
          source: OWNER,
        },
      },
    ]);
  });

  test("prepares operator settlement against the same signed maker account", () => {
    const requests: unknown[] = [];
    const relayer = {
      prepareXdr: (request: unknown) => {
        requests.push(request);
        return { xdr: "operator-signature-required" };
      },
    } as unknown as Pick<RelayerService, "readAsync" | "prepareXdr">;
    const vault = new LiquidityVaultService(relayer, deployment);
    vault.prepare(OWNER, { action: "set-paused", paused: true });
    vault.prepare(OWNER, { action: "allocate", amount: "80000000" });
    vault.prepare(OWNER, { action: "settle", principal: "80000000", returned: "81000000" });
    expect(requests.map((request) => (request as { payload: { functionName: string } }).payload.functionName))
      .toEqual(["set_paused", "allocate", "settle"]);
    expect((requests[2] as { payload: { args: string[] } }).payload.args).toEqual([
      "--principal", "80000000", "--returned", "81000000",
    ]);
    expect(() => vault.prepare(OWNER, { action: "set-allocation-limit", allocationLimitBps: 8001 })).toThrow();
  });

  test("rejects unsafe amounts and an absent deployment", () => {
    const relayer = {
      prepareXdr: () => { throw new Error("must not prepare"); },
    } as unknown as Pick<RelayerService, "readAsync" | "prepareXdr">;
    const vault = new LiquidityVaultService(relayer, deployment);
    expect(() => vault.prepare(OWNER, { action: "deposit", amount: "-1", minShares: "0" })).toThrow();
    expect(() => vault.prepare(OWNER, { action: "deposit", amount: "1.5", minShares: "0" })).toThrow();
    expect(() => vault.prepare(OWNER, { action: "deposit", amount: "0", minShares: "0" })).toThrow();
    expect(() => vault.prepare(OWNER, { action: "deposit", amount: (1n << 127n).toString(), minShares: "0" })).toThrow();
    expect(() => new LiquidityVaultService(relayer).prepare(OWNER, { action: "claim-withdrawal", minAssets: "0" })).toThrow("not deployed");
  });
});
