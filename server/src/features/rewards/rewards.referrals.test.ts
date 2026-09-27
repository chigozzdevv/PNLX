import { expect, test } from "bun:test";
import { ownerCommitment } from "@pnlx/crypto";
import { ReferralRegistry } from "@/features/rewards/rewards.referrals";
import { ProtocolStore } from "@/shared/state/store";

const ALICE = "GDNHJPGBEPMMAINDMU3TN6V6PCDQKXWVY4FWHLMBJXPCBSCKLUYIESOC";
const BOB = "GBYSI3TGYUERHKZTHQ7Q4AOYOM4X2BXWCQLWEOF3ZMCUE7YXYF7XG2PY";
const CAROL = "GC5HQAVTBS7R77ZT4COG6LMQ6ZSSR7AS4EW3QZMUPSNZQCTR4NS4G3OD";

test("referral attribution is immutable and blocks self-referrals and direct loops", async () => {
  const registry = new ReferralRegistry();
  const store = new ProtocolStore();
  const first = await registry.register(BOB, ALICE, store);
  expect(first.referrer).toBe(ownerCommitment(ALICE));
  expect(await registry.register(BOB, ALICE, store)).toEqual(first);
  expect((await registry.forReferrer(ownerCommitment(ALICE))).length).toBe(1);
  expect(registry.register(BOB, CAROL, store)).rejects.toThrow("already has a referrer");
  expect(registry.register(ALICE, BOB, store)).rejects.toThrow("loops");
  await registry.register(CAROL, BOB, store);
  expect(registry.register(ALICE, CAROL, store)).rejects.toThrow("loops");
  expect(registry.register(CAROL, CAROL, store)).rejects.toThrow("own wallet");
});
