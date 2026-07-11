import { createHash } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";
import type { MongoProtocolStoreOptions } from "@/shared/mongo/store";
import type { ExternalBatchSettlementTranscript } from "@/workers/executor/executor.model";
import type { CreateExternalSettlementInput } from "@/workers/matcher/matcher.model";

export type MatcherJobStatus = "queued" | "proving" | "completed" | "failed";

interface MatcherJobDocument {
  _id: string;
  attempts: number;
  createdAt: Date;
  error?: string;
  input: string;
  result?: string;
  status: MatcherJobStatus;
  updatedAt: Date;
}

export interface MatcherJobView {
  attempts: number;
  error?: string;
  jobId: string;
  status: MatcherJobStatus;
  transcript?: ExternalBatchSettlementTranscript;
  updatedAt: number;
}

type MatcherJobProcessor = (
  input: CreateExternalSettlementInput,
) => Promise<ExternalBatchSettlementTranscript>;

export class MatcherJobService {
  private readonly active = new Set<string>();
  private readonly memory = new Map<string, MatcherJobDocument>();

  private constructor(
    private readonly processor: MatcherJobProcessor,
    private readonly collection?: Collection<MatcherJobDocument>,
    private readonly client?: MongoClient,
  ) {}

  static memory(processor: MatcherJobProcessor): MatcherJobService {
    return new MatcherJobService(processor);
  }

  static async connect(
    options: MongoProtocolStoreOptions,
    processor: MatcherJobProcessor,
  ): Promise<MatcherJobService> {
    const client = new MongoClient(options.uri);
    await client.connect();
    const db = client.db(options.database || "pnlx");
    const collection = db.collection<MatcherJobDocument>(
      `${options.collection || "protocol_state"}_matcher_jobs`,
    );
    await collection.createIndex({ status: 1, updatedAt: 1 });
    const service = new MatcherJobService(processor, collection, client);
    await collection.updateMany(
      { status: "proving" },
      { $set: { status: "queued", updatedAt: new Date() } },
    );
    const pending = await collection.find({ status: "queued" }).project({ _id: 1 }).toArray();
    for (const job of pending) service.kick(String(job._id));
    return service;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  async enqueue(input: CreateExternalSettlementInput): Promise<MatcherJobView> {
    const jobId = matcherJobId(input);
    const now = new Date();
    const inputJson = encode(input);
    if (this.collection) {
      await this.collection.updateOne(
        { _id: jobId },
        {
          $setOnInsert: {
            _id: jobId,
            attempts: 0,
            createdAt: now,
            input: inputJson,
            status: "queued",
            updatedAt: now,
          },
        },
        { upsert: true },
      );
      await this.collection.updateOne(
        { _id: jobId, attempts: { $lt: 5 }, status: "failed" },
        { $set: { error: undefined, status: "queued", updatedAt: now } },
      );
    } else if (!this.memory.has(jobId)) {
      this.memory.set(jobId, {
        _id: jobId,
        attempts: 0,
        createdAt: now,
        input: inputJson,
        status: "queued",
        updatedAt: now,
      });
    }
    this.kick(jobId);
    return this.get(jobId);
  }

  async get(jobId: string): Promise<MatcherJobView> {
    const document = this.collection
      ? await this.collection.findOne({ _id: jobId })
      : this.memory.get(jobId);
    if (!document) throw new Error("matcher job not found");
    return {
      attempts: document.attempts,
      ...(document.error ? { error: document.error } : {}),
      jobId: document._id,
      status: document.status,
      ...(document.result
        ? { transcript: decode<ExternalBatchSettlementTranscript>(document.result) }
        : {}),
      updatedAt: document.updatedAt.getTime(),
    };
  }

  private kick(jobId: string): void {
    if (this.active.has(jobId)) return;
    this.active.add(jobId);
    queueMicrotask(() => {
      void this.process(jobId).finally(() => this.active.delete(jobId));
    });
  }

  private async process(jobId: string): Promise<void> {
    const document = await this.claim(jobId);
    if (!document) return;
    try {
      const transcript = await this.processor(decode<CreateExternalSettlementInput>(document.input));
      await this.complete(jobId, transcript);
    } catch (error) {
      await this.fail(jobId, error instanceof Error ? error.message : String(error));
    }
  }

  private async claim(jobId: string): Promise<MatcherJobDocument | undefined> {
    const now = new Date();
    if (this.collection) {
      return await this.collection.findOneAndUpdate(
        { _id: jobId, status: "queued" },
        { $inc: { attempts: 1 }, $set: { status: "proving", updatedAt: now } },
        { returnDocument: "after" },
      ) ?? undefined;
    }
    const document = this.memory.get(jobId);
    if (!document || document.status !== "queued") return undefined;
    const claimed = { ...document, attempts: document.attempts + 1, status: "proving" as const, updatedAt: now };
    this.memory.set(jobId, claimed);
    return claimed;
  }

  private async complete(jobId: string, transcript: ExternalBatchSettlementTranscript): Promise<void> {
    const update = {
      error: undefined,
      result: encode(transcript),
      status: "completed" as const,
      updatedAt: new Date(),
    };
    if (this.collection) {
      await this.collection.updateOne({ _id: jobId, status: "proving" }, { $set: update });
    } else {
      const current = this.memory.get(jobId);
      if (current) this.memory.set(jobId, { ...current, ...update });
    }
  }

  private async fail(jobId: string, error: string): Promise<void> {
    const update = { error, status: "failed" as const, updatedAt: new Date() };
    if (this.collection) {
      await this.collection.updateOne({ _id: jobId, status: "proving" }, { $set: update });
    } else {
      const current = this.memory.get(jobId);
      if (current) this.memory.set(jobId, { ...current, ...update });
    }
  }
}

function matcherJobId(input: CreateExternalSettlementInput): string {
  return createHash("sha256").update(encode(input)).digest("hex");
}

function encode(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? { __pnlxBigInt: entry.toString() } : entry
  );
}

function decode<T>(value: string): T {
  return JSON.parse(value, (_key, entry) => {
    if (
      entry &&
      typeof entry === "object" &&
      "__pnlxBigInt" in entry &&
      typeof entry.__pnlxBigInt === "string"
    ) {
      return BigInt(entry.__pnlxBigInt);
    }
    return entry;
  }) as T;
}
