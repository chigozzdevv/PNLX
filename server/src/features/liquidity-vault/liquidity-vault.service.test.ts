import { expect, test } from "bun:test";
import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import { LiquidityVaultService } from "./liquidity-vault.service";

const owner = "GBVC7NWAYW4DTAF3GG6W2SPMJZO7EXHQL4LGJZPWOTHIL373PK6XQ3QJ";

test("shares one vault status read across simultaneous page and history requests", async () => {
  const methods: string[] = [];
  const outputs: Record<string, string> = {
    asset: JSON.stringify(owner), operator: JSON.stringify(owner), maker: JSON.stringify(owner),
    paused: "false", liquid_assets: "100", deployed_principal: "50", total_shares: "150",
    allocation_limit_bps: "8000", current_series: "1", deposit_series: "1",
    series_assets: "150", series_liquid: "100", series_principal: "50", series_total_shares: "150",
  };
  const relayer = {
    readAsync: async ({ payload }: { payload: { functionName: string } }) => {
      methods.push(payload.functionName);
      return { output: outputs[payload.functionName] };
    },
  } as unknown as Pick<RelayerService, "readAsync" | "prepareXdr">;
  const deployment = { contracts: { "liquidity-vault": "vault" } } as unknown as DeploymentRegistry;
  const vault = new LiquidityVaultService(relayer, deployment);
  const [page, history] = await Promise.all([vault.status(), vault.status()]);
  expect(page).toBe(history);
  expect(page.totalAssetsAtCost).toBe("150");
  expect(methods).toHaveLength(14);
  await vault.status();
  expect(methods).toHaveLength(14);
});

test("wallet position aggregates series without redundant contract reads", async () => {
  const methods: string[] = [];
  const relayer = {
    readAsync: async ({ payload }: { payload: { functionName: string; args?: string[] } }) => {
      const method = payload.functionName;
      methods.push(method);
      const series = payload.args?.[1];
      const output = method === "owner_series" ? "[0,1]"
        : method === "deposited" ? "300"
        : method === "withdrawn" ? "0"
        : method === "series_position" && series === "0"
          ? JSON.stringify({ series: 0, shares: "100", pending_shares: "25", assets_at_cost: "110",
            deployed_principal: "0", series_assets: "1100", series_total_shares: "1000" })
          : method === "series_position" && series === "1"
            ? JSON.stringify({ series: 1, shares: "200", pending_shares: "0", assets_at_cost: "200",
              deployed_principal: "50", series_assets: "2000", series_total_shares: "2000" })
            : (() => { throw new Error(`unexpected read: ${method}`); })();
      return { output };
    },
  } as unknown as Pick<RelayerService, "readAsync" | "prepareXdr">;
  const deployment = { contracts: { "liquidity-vault": "vault" } } as unknown as DeploymentRegistry;
  const account = await new LiquidityVaultService(relayer, deployment).account(owner);
  expect(account).toMatchObject({ shares: "300", pendingShares: "25", availableShares: "275",
    deposited: "300", withdrawn: "0", equity: null });
  expect(account.positions.map((position) => position.availableShares)).toEqual(["75", "200"]);
  expect(methods.sort()).toEqual(["deposited", "owner_series", "series_position", "series_position", "withdrawn"]);
});
