import { expect, test } from "bun:test";
import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import { LiquidityVaultService } from "./liquidity-vault.service";

const owner = "GBVC7NWAYW4DTAF3GG6W2SPMJZO7EXHQL4LGJZPWOTHIL373PK6XQ3QJ";

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
