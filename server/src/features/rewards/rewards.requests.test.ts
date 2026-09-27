import { expect, test } from "bun:test";
import { RewardRequestRegistry } from "@/features/rewards/rewards.requests";

test("reward requests stay unique until they are credited", async () => {
  const requests = new RewardRequestRegistry();
  await requests.queue("escrow", "wallet", "rebate");
  await requests.queue("escrow", "wallet", "rebate");
  await requests.queue("escrow", "wallet", "referral");
  expect((await requests.pending("escrow")).map((request) => request.kind).sort())
    .toEqual(["rebate", "referral"]);
  await requests.complete("escrow:wallet:rebate");
  expect((await requests.pending("escrow")).map((request) => request.kind)).toEqual(["referral"]);
});
