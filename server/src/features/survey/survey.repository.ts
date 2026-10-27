import { MongoClient, type Collection } from "mongodb";
import { SURVEY_ID, type SurveySubmission } from "@pnlx/survey";

export interface SurveyDocument extends SurveySubmission {
  _id: string;
  surveyId: string;
  receivedAt: Date;
}

export interface SurveyRepository {
  save(submission: SurveySubmission): Promise<boolean>;
}

export const SURVEY_COLLECTION = "survey_responses";

/** Survey records are independent of protocol checkpoints and trading account state. */
export class MongoSurveyRepository implements SurveyRepository {
  private connection?: Promise<Collection<SurveyDocument>>;

  constructor(private readonly uri: string, private readonly database: string) {}

  private collection(): Promise<Collection<SurveyDocument>> {
    if (!this.uri) throw new Error("Survey database is not configured");
    if (!this.connection) {
      const client = new MongoClient(this.uri, {
        maxPoolSize: 3, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000,
      });
      this.connection = client.connect().then(() => client.db(this.database).collection<SurveyDocument>(SURVEY_COLLECTION))
        .catch(async (error: unknown) => {
          this.connection = undefined;
          await client.close();
          throw error;
        });
    }
    return this.connection;
  }

  async save(submission: SurveySubmission): Promise<boolean> {
    const collection = await this.collection();
    const id = `${SURVEY_ID}:${submission.submissionId}`;
    // The primary key makes retries safe, including after a lost HTTP response.
    try {
      const result = await collection.updateOne({ _id: id }, {
        $setOnInsert: { ...submission, _id: id, surveyId: SURVEY_ID, receivedAt: new Date() },
      }, { upsert: true });
      return result.upsertedCount === 1;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 11000) return false;
      throw error;
    }
  }
}
