import { expect, test } from "bun:test";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import type { DeploymentRegistry } from "@/workers/onchain/onchain.model";
import { RewardsService } from "@/features/rewards/rewards.service";
import { ReferralRegistry } from "@/features/rewards/rewards.referrals";
import { ProtocolStore } from "@/shared/state/store";

const OWNER = "GDNHJPGBEPMMAINDMU3TN6V6PCDQKXWVY4FWHLMBJXPCBSCKLUYIESOC";
const ESCROW = `C${"A".repeat(55)}`;

test("reward claims are prepared for the signed-in wallet and correct claim kind", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const relayer = {
    readAsync: async (request: Record<string, unknown>) => {
      calls.push(request);
      return { output: '"10000000"' };
    },
    prepareXdr: (request: Record<string, unknown>) => {
      calls.push(request);
      return { xdr: "prepared-xdr", txHash: "tx-hash" };
    },
  } as unknown as Pick<RelayerService, "readAsync" | "prepareXdr">;
  const deployment = { contracts: { "rewards-escrow": ESCROW } } as unknown as DeploymentRegistry;
  const rewards = new RewardsService(relayer, new ProtocolStore(), new ReferralRegistry(), undefined, deployment);

  expect(await rewards.prepareClaim(OWNER, "referral")).toEqual({
    contractId: ESCROW, kind: "referral", owner: OWNER, txHash: "tx-hash", xdr: "prepared-xdr",
  });
  expect(calls[0].payload).toMatchObject({ args: ["--owner", OWNER, "--kind", "1"],
    contractId: ESCROW, functionName: "claimable", send: "no" });
  expect(calls[1].payload).toMatchObject({ args: ["--owner", OWNER, "--kind", "1"],
    buildOnly: true, contractId: ESCROW, functionName: "claim", source: OWNER });
});
