import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MongoClient } from "mongodb";
import { SURVEY_ID, emptySurveyAnswers, surveyCsvCell } from "@pnlx/survey";
import { loadEnv } from "../../server/src/config/env";
import { SURVEY_COLLECTION, type SurveyDocument } from "../../server/src/features/survey/survey.repository";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
if (!output || output.startsWith("--")) {
  console.error("Usage: bun run survey:export --output /path/responses.csv [--include-contact]");
  process.exit(1);
}
const env = loadEnv({ validateRuntime: false });
if (!env.mongodbUri) throw new Error("MONGODB_URI is required to export survey responses");
const includeContact = args.includes("--include-contact");
const fields = Object.keys(emptySurveyAnswers()).filter((field) => includeContact || !["contact", "contactMethod"].includes(field));
const headers = ["submissionId", "receivedAt", "source", ...fields];
const rows = [headers.map(surveyCsvCell).join(",")];
const client = new MongoClient(env.mongodbUri, { serverSelectionTimeoutMS: 5000 });
try {
  await client.connect();
  const cursor = client.db(env.mongodbDatabase).collection<SurveyDocument>(SURVEY_COLLECTION)
    .find({ surveyId: SURVEY_ID }).sort({ receivedAt: 1 });
  let count = 0;
  for await (const record of cursor) {
    const cells = [record.submissionId, record.receivedAt.toISOString(), record.source ?? "", ...fields.map((field) => {
      const value = record.answers[field as keyof typeof record.answers];
      return Array.isArray(value) ? value.join("; ") : value;
    })];
    rows.push(cells.map(surveyCsvCell).join(","));
    count++;
  }
  // Owner-only file permissions; refuse to replace an existing export.
  await writeFile(resolve(output), `\uFEFF${rows.join("\r\n")}\r\n`, { flag: "wx", mode: 0o600 });
  console.log(`Exported ${count} survey responses to ${resolve(output)}${includeContact ? " (including opted-in contact details)" : " (contact details excluded)"}.`);
} finally { await client.close(); }
