import { MongoClient, type Collection } from "mongodb";
import type { ClaimableRewardKind } from "@/features/rewards/rewards.model";

export interface RewardRequest {
  _id: string;
  contractId: string;
  createdAt: string;
  kind: ClaimableRewardKind;
  owner: string;
}

export class RewardRequestRegistry {
  private readonly local = new Map<string, RewardRequest>();

  constructor(private readonly config?: { uri: string; database: string }) {}

  async queue(contractId: string, owner: string, kind: ClaimableRewardKind): Promise<void> {
    const record: RewardRequest = { _id: `${contractId}:${owner}:${kind}`, contractId, owner, kind,
      createdAt: new Date().toISOString() };
    if (!this.config) { this.local.set(record._id, this.local.get(record._id) ?? record); return; }
    await this.withCollection((collection) => collection.updateOne({ _id: record._id },
      { $setOnInsert: record }, { upsert: true }));
  }

  async pending(contractId: string): Promise<RewardRequest[]> {
    if (!this.config) return [...this.local.values()].filter((record) => record.contractId === contractId);
    return this.withCollection((collection) => collection.find({ contractId }).sort({ createdAt: 1 }).toArray());
  }

  async complete(id: string): Promise<void> {
    if (!this.config) { this.local.delete(id); return; }
    await this.withCollection((collection) => collection.deleteOne({ _id: id }));
  }

  private async withCollection<T>(action: (collection: Collection<RewardRequest>) => Promise<T>): Promise<T> {
    const client = new MongoClient(this.config!.uri);
    try {
      await client.connect();
      return await action(client.db(this.config!.database).collection<RewardRequest>("reward_requests"));
    } finally { await client.close(); }
  }
}
