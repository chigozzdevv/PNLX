import { loadEnv } from "../../server/src/config/env";
import { MongoProtocolStore } from "../../server/src/shared/state/mongo-store";

const env = loadEnv();
const store = await MongoProtocolStore.connect({
  collection: env.mongodbCollection,
  database: env.mongodbDatabase,
  documentId: env.stellarNetwork,
  ensureIndexes: true,
  uri: env.mongodbUri,
});

try {
  const before = store.persistenceStatus();
  const after = await store.migrate();
  console.log(JSON.stringify({
    after,
    before,
    counts: {
      intents: store.intents.size,
      marginCommitments: store.marginCommitments.size,
      positionCommitments: store.positionCommitments.size,
      positions: store.positionLifecycle.size,
      settlements: store.settlements.size,
      spentNullifiers: store.spentNullifiers.size,
    },
    positionRoot: store.positionMembershipRoot(),
  }, null, 2));
} finally {
  await store.close();
}
