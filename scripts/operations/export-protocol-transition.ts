import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "../../server/src/config/env";
import { readMakerNotes } from "../../server/src/shared/maker-note-store";
import { MongoProtocolStore } from "../../server/src/shared/state/mongo-store";
import {
  bigintReplacer,
  snapshotProtocolStore,
} from "../../server/src/shared/state/protocol-snapshot";
import { loadDeploymentRegistry } from "../../server/src/workers/onchain/deployment";
import { createOnchainRelay } from "../../server/src/workers/onchain/onchain.worker";
import { createRelayer } from "../../server/src/workers/relayer/relayer.worker";

const outputPath = requiredArgument("--out");
if (existsSync(outputPath)) throw new Error(`refusing to overwrite transition export: ${outputPath}`);

const env = loadEnv();
const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
const relayer = createRelayer({
  config: {
    mode: env.stellarRelayerMode === "stellar-cli" ? "stellar-cli" : "local",
    network: env.stellarNetwork,
    networkPassphrase: env.stellarNetworkPassphrase,
    rpcUrl: env.stellarRpcUrl,
    source: env.stellarSource,
  },
});
const onchain = createOnchainRelay(relayer, { deployment, enabled: true });
const store = await MongoProtocolStore.connect({
  collection: env.mongodbCollection,
  database: env.mongodbDatabase,
  documentId: env.stellarNetwork,
  uri: env.mongodbUri,
});

try {
  const snapshot = snapshotProtocolStore(store);
  const localPositionRoot = store.positionMembershipRoot();
  const onchainPositionRoot = onchain.positionRoot();
  if (localPositionRoot.toLowerCase() !== onchainPositionRoot.toLowerCase()) {
    throw new Error(
      `refusing inconsistent export: Mongo position root ${localPositionRoot}, on-chain ${onchainPositionRoot}`,
    );
  }
  const makerNotes = await readMakerNotes();
  const exportDocument = {
    audit: {
      accountEvents: snapshot.accountEvents.length,
      batchRuns: snapshot.batchExecutionRuns.length,
      marginCommitments: snapshot.marginCommitments.length,
      makerNotes: makerNotes.length,
      openOrders: snapshot.orderLifecycle.filter(([, order]) =>
        order.status === "open" || order.status === "partially-filled"
      ).length,
      positionCommitments: snapshot.positionCommitments.length,
      positions: snapshot.positionLifecycle.length,
      settlements: snapshot.settlements.length,
      spentNullifiers: snapshot.spentNullifiers.length,
    },
    deployment,
    exportedAt: new Date().toISOString(),
    makerNotes,
    network: env.stellarNetwork,
    roots: {
      margin: store.marginMembershipRoot(),
      position: localPositionRoot,
    },
    schema: "pnlx-protocol-transition-v1",
    snapshot,
  };
  writeFileSync(
    outputPath,
    `${JSON.stringify(exportDocument, bigintReplacer, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify({
    audit: exportDocument.audit,
    output: resolve(outputPath),
    roots: exportDocument.roots,
    schema: exportDocument.schema,
  }, null, 2));
} finally {
  await store.close();
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}
