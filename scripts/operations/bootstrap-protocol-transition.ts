import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashFields, positionMerkleRoot } from "@pnlx/crypto";
import type {
  Hex,
  PositionCloseRecord,
  PositionLifecycleRecord,
} from "@pnlx/protocol-types";
import { loadEnv } from "../../server/src/config/env";
import {
  bigintReviver,
  type ProtocolStoreSnapshot,
} from "../../server/src/shared/state/protocol-snapshot";
import { loadDeploymentRegistry } from "../../server/src/workers/onchain/deployment";

interface TransitionExport {
  network: string;
  roots: { margin: Hex; position: Hex };
  schema: "pnlx-protocol-transition-v1";
  snapshot: ProtocolStoreSnapshot;
}

const exportPath = requiredArgument("--export");
const deploymentPath = requiredArgument("--deployment");
if (!process.argv.includes("--collateral-backed")) {
  throw new Error(
    "--collateral-backed is required after independently funding the new shielded pool with the old pool balance",
  );
}

const env = loadEnv();
const transition = JSON.parse(readFileSync(exportPath, "utf8"), bigintReviver) as TransitionExport;
if (transition.schema !== "pnlx-protocol-transition-v1") {
  throw new Error("unsupported protocol transition export");
}
if (transition.network !== env.stellarNetwork) {
  throw new Error("transition export network does not match runtime network");
}
const deployment = loadDeploymentRegistry(deploymentPath);
if (!deployment) throw new Error(`deployment not found: ${deploymentPath}`);
if (deployment.network !== env.stellarNetwork) {
  throw new Error("target deployment network does not match runtime network");
}

const positionCommitments = transition.snapshot.positionCommitments;
const calculatedRoot = positionMerkleRoot(positionCommitments);
if (calculatedRoot !== transition.roots.position) {
  throw new Error(
    `transition position root mismatch: expected ${transition.roots.position}, calculated ${calculatedRoot}`,
  );
}

const sourceAddress = deployment.sourceAddress;
const positionState = deployment.contracts["position-state"];
const shieldedPool = deployment.contracts["shielded-pool"];
const intentRegistry = deployment.contracts["intent-registry"];
const conditionalOrder = deployment.contracts["conditional-order"];

const importedPositionCount = readU32(positionState, "leaf_count", []);
if (importedPositionCount > positionCommitments.length) {
  throw new Error("target position tree contains more leaves than the transition export");
}
const importedPositionRoot = readBytes32(positionState, "current_root", []);
const expectedImportedRoot = positionMerkleRoot(positionCommitments.slice(0, importedPositionCount));
if (importedPositionRoot !== expectedImportedRoot) {
  throw new Error(
    `target position prefix mismatch at leaf ${importedPositionCount}: expected ${expectedImportedRoot}, received ${importedPositionRoot}`,
  );
}
invoke(positionState, "set_writer", ["--writer", sourceAddress, "--enabled", "true"]);
for (const commitments of chunks(positionCommitments.slice(importedPositionCount), 8)) {
  invoke(positionState, "append_many", [
    "--writer",
    sourceAddress,
    "--commitments",
    bytes32Vec(commitments),
  ]);
}
const targetRoot = readBytes32(positionState, "current_root", []);
if (targetRoot !== transition.roots.position) {
  throw new Error(
    `bootstrapped position root mismatch: expected ${transition.roots.position}, received ${targetRoot}`,
  );
}

for (const spend of positionSpends(transition.snapshot)) {
  if (readBool(positionState, "is_spent", ["--position_nullifier", bytes32(spend.positionNullifier)])) {
    continue;
  }
  invoke(positionState, "spend_position", [
    "--writer",
    sourceAddress,
    "--membership_root",
    bytes32(targetRoot),
    "--position_commitment",
    bytes32(spend.positionCommitment),
    "--position_nullifier",
    bytes32(spend.positionNullifier),
  ]);
}
invoke(positionState, "set_writer", ["--writer", sourceAddress, "--enabled", "false"]);

for (const commitment of transition.snapshot.marginCommitments) {
  if (readBool(shieldedPool, "has_commitment", ["--commitment", bytes32(commitment)])) continue;
  invoke(shieldedPool, "deposit", ["--commitment", bytes32(commitment)]);
}
const positionNullifiers = new Set(positionSpends(transition.snapshot).map((spend) => spend.positionNullifier));
const marginNullifiers = transition.snapshot.spentNullifiers.filter(
  (nullifier) => !positionNullifiers.has(nullifier),
);
invoke(shieldedPool, "set_writer", ["--writer", sourceAddress, "--enabled", "true"]);
for (const nullifier of marginNullifiers) {
  if (readBool(shieldedPool, "is_spent", ["--nullifier", bytes32(nullifier)])) continue;
  invoke(shieldedPool, "spend", [
    "--writer",
    sourceAddress,
    "--nullifier",
    bytes32(nullifier),
  ]);
}
invoke(shieldedPool, "set_writer", ["--writer", sourceAddress, "--enabled", "false"]);

for (const [, order] of transition.snapshot.orderLifecycle) {
  if (order.status !== "open" && order.status !== "partially-filled") continue;
  const intent = transition.snapshot.intents.find(([, record]) =>
    record.intentCommitment === order.intentCommitment
  )?.[1];
  const residual = transition.snapshot.residualOrders.find(([, record]) =>
    record.intentCommitment === order.intentCommitment
  )?.[1];
  const record = intent ?? residual;
  if (!record) throw new Error(`active order ${order.intentCommitment} has no sealed record`);
  if (readBool(intentRegistry, "has_intent", [
    "--intent_commitment",
    bytes32(record.intentCommitment),
  ])) continue;
  invoke(intentRegistry, "submit", [
    "--batch_id",
    bytes32(batchKey(record.batchId)),
    "--market_id",
    bytes32(marketKey(record.marketId)),
    "--intent_commitment",
    bytes32(record.intentCommitment),
    "--encrypted_shares_commitment",
    bytes32(record.matchingPayloadCommitment),
  ]);
}

for (const [, order] of transition.snapshot.conditionalOrders) {
  if (transition.snapshot.conditionalCloses.some(([close]) => close === order.closeCommitment)) continue;
  invoke(conditionalOrder, "register", [
    "--market_id",
    bytes32(marketKey(order.marketId)),
    "--position_nullifier",
    bytes32(order.positionNullifier),
    "--close_commitment",
    bytes32(order.closeCommitment),
  ]);
}

console.log(JSON.stringify({
  imported: {
    activeIntents: transition.snapshot.orderLifecycle.filter(([, order]) =>
      order.status === "open" || order.status === "partially-filled"
    ).length,
    marginCommitments: transition.snapshot.marginCommitments.length,
    marginNullifiers: marginNullifiers.length,
    positionCommitments: positionCommitments.length,
    positionNullifiers: positionNullifiers.size,
  },
  positionRoot: targetRoot,
  schema: transition.schema,
}, null, 2));

function positionSpends(snapshot: ProtocolStoreSnapshot): Array<{
  positionCommitment: Hex;
  positionNullifier: Hex;
}> {
  const spends = new Map<Hex, { positionCommitment: Hex; positionNullifier: Hex }>();
  for (const [, close] of snapshot.positionCloses as [Hex, PositionCloseRecord][]) {
    spends.set(close.positionNullifier, close);
  }
  for (const [, liquidation] of snapshot.liquidations) {
    spends.set(liquidation.positionNullifier, liquidation);
  }
  for (const [, position] of snapshot.positionLifecycle as [Hex, PositionLifecycleRecord][]) {
    if (position.status !== "open") {
      spends.set(position.positionNullifier, position);
    }
  }
  return [...spends.values()];
}

function invoke(contractId: string, method: string, args: string[]): string {
  const command = stellarCommand(contractId, method, args);
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `stellar ${method} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  return result.stdout.trim();
}

function readBytes32(contractId: string, method: string, args: string[]): Hex {
  const output = invoke(contractId, method, args);
  const match = output.match(/(?:0x)?([0-9a-fA-F]{64})/);
  if (!match) throw new Error(`${method} did not return bytes32`);
  return `0x${match[1].toLowerCase()}`;
}

function readBool(contractId: string, method: string, args: string[]): boolean {
  const output = invoke(contractId, method, args).trim();
  if (output === "true") return true;
  if (output === "false") return false;
  throw new Error(`${method} did not return a boolean`);
}

function readU32(contractId: string, method: string, args: string[]): number {
  const output = invoke(contractId, method, args).trim();
  const value = Number(output.match(/\d+/)?.[0]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${method} did not return a u32`);
  }
  return value;
}

function stellarCommand(contractId: string, method: string, args: string[]): string[] {
  return [
    "stellar",
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    env.stellarSource,
    "--network",
    env.stellarNetwork,
    "--rpc-url",
    env.stellarRpcUrl,
    "--network-passphrase",
    env.stellarNetworkPassphrase,
    "--send",
    "yes",
    "--auto-sign",
    "--",
    method,
    ...args,
  ];
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function bytes32(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function bytes32Vec(values: string[]): string {
  return JSON.stringify(values.map(bytes32));
}

function batchKey(batchId: string): Hex {
  return digestKey("batch-id", batchId);
}

function marketKey(marketId: string): Hex {
  return digestKey("market-id", marketId);
}

function digestKey(domain: string, value: string): Hex {
  return hashFields(domain, [value]);
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}
