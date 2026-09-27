import { ownerCommitment } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";
import { MongoClient, type Collection } from "mongodb";
import type { ProtocolStore } from "@/shared/state/store";

export interface ReferralAttribution {
  _id: Hex;
  referred: Hex;
  referrer: Hex;
  registeredAt: number;
}

export class ReferralRegistry {
  private readonly local = new Map<Hex, ReferralAttribution>();

  constructor(private readonly config?: { uri: string; database: string }) {}

  async forReferrer(owner: Hex): Promise<ReferralAttribution[]> {
    if (!this.config) return [...this.local.values()].filter((entry) => entry.referrer === owner);
    return this.withCollection((collection) => collection.find({ referrer: owner }).toArray());
  }

  async register(referredAddress: string, referrerAddress: string, store: ProtocolStore): Promise<ReferralAttribution> {
    const referred = ownerCommitment(validAddress(referredAddress));
    const referrer = ownerCommitment(validAddress(referrerAddress));
    if (referred === referrer) throw new Error("You cannot refer your own wallet");
    const existing = await this.get(referred);
    if (existing) {
      if (existing.referrer !== referrer) throw new Error("This wallet already has a referrer");
      return existing;
    }
    const visited = new Set<Hex>();
    let current: Hex | undefined = referrer;
    while (current && !visited.has(current)) {
      if (current === referred) throw new Error("Referral loops are not allowed");
      visited.add(current);
      current = (await this.get(current))?.referrer;
    }
    for (const settlement of store.settlements.values()) {
      if (!settlement.onchainConfirmed) continue;
      if ([...settlement.makerIntents, ...settlement.takerIntents]
        .some((id) => (store.privateMatchIntents.get(id)?.ownerCommitment ??
          store.intents.get(id)?.ownerCommitment ??
          store.residualOrders.get(id)?.ownerCommitment) === referred)) {
        throw new Error("Referral must be registered before the first settled trade");
      }
    }
    const attribution: ReferralAttribution = { _id: referred, referred, referrer, registeredAt: Date.now() };
    if (!this.config) { this.local.set(referred, attribution); return attribution; }
    const recorded = await this.withCollection((collection) => collection.findOneAndUpdate(
      { _id: referred }, { $setOnInsert: attribution }, { upsert: true, returnDocument: "after" },
    ));
    if (!recorded || recorded.referrer !== referrer) throw new Error("This wallet already has a referrer");
    return recorded;
  }

  private async get(owner: Hex): Promise<ReferralAttribution | null> {
    if (!this.config) return this.local.get(owner) ?? null;
    return this.withCollection((collection) => collection.findOne({ _id: owner }));
  }

  private async withCollection<T>(action: (collection: Collection<ReferralAttribution>) => Promise<T>): Promise<T> {
    const client = new MongoClient(this.config!.uri);
    try {
      await client.connect();
      return await action(client.db(this.config!.database).collection<ReferralAttribution>("reward_referrals"));
    } finally { await client.close(); }
  }
}

function validAddress(value: string): string {
  const address = value.trim().toUpperCase();
  if (!/^G[A-Z2-7]{55}$/.test(address)) throw new Error("Invalid referral wallet address");
  return address;
}
