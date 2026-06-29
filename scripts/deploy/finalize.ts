import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fieldMerkleRoot } from "@merkl/crypto";
import { circuitKey } from "@merkl/proof-system";
import type { Hex } from "@merkl/protocol-types";
import { loadEnv } from "@/config/env";
import { createDeployManifest } from "./manifest";

interface Deployment {
  contracts: Record<string, string>;
  network: string;
  source: string;
  sourceAddress: string;
  verifiers: Record<string, string>;
}

const env = loadEnv();
const root = process.cwd();
const deployment = readDeployment();
const manifest = createDeployManifest(root);
const INITIAL_POSITION_ROOT = fieldMerkleRoot([]);

invoke(deployment.contracts.governance, "init", ["--admin", deployment.sourceAddress], true);
invoke(deployment.contracts["proof-ledger"], "init", [
  "--governance",
  deployment.contracts.governance,
], true);
invoke(deployment.contracts["price-oracle"], "init", [
  "--admin",
  deployment.sourceAddress,
  "--decimals",
  String(env.oraclePriceDecimals),
], true);

for (const verifier of manifest.verifiers) {
  const verifierId = deployment.verifiers[verifier.verifierAuthority];
  invoke(verifierId, "init", [
    "--governance",
    deployment.contracts.governance,
    "--proof_ledger",
    deployment.contracts["proof-ledger"],
    "--circuit_id",
    bytes32(verifier.circuitKey),
    "--verifier_hash",
    bytes32(verifier.verifierHash),
    "--vk_bytes-file-path",
    verifier.vkPath,
  ], true);
  invoke(deployment.contracts.governance, "set_verifier", [
    "--circuit_id",
    bytes32(verifier.circuitKey),
    "--verifier_hash",
    bytes32(verifier.verifierHash),
    "--authority",
    verifierId,
  ]);
}

invoke(deployment.contracts["shielded-pool"], "init", [
  "--governance",
  deployment.contracts.governance,
  "--proof_ledger",
  deployment.contracts["proof-ledger"],
  "--deposit_circuit_id",
  bytes32(circuitKey("deposit-note")),
  "--withdraw_circuit_id",
  bytes32(circuitKey("withdraw")),
], true);
invoke(deployment.contracts.market, "init", [
  "--governance",
  deployment.contracts.governance,
], true);
invoke(deployment.contracts["funding-settlement"], "init", [
  "--governance",
  deployment.contracts.governance,
  "--proof_ledger",
  deployment.contracts["proof-ledger"],
  "--market_contract",
  deployment.contracts.market,
  "--circuit_id",
  bytes32(circuitKey("funding-update")),
], true);
invoke(deployment.contracts["position-state"], "init", [
  "--governance",
  deployment.contracts.governance,
  "--initial_root",
  bytes32(INITIAL_POSITION_ROOT),
], true);
invoke(deployment.contracts["batch-settlement"], "init", [
  "--governance",
  deployment.contracts.governance,
  "--proof_ledger",
  deployment.contracts["proof-ledger"],
  "--market_contract",
  deployment.contracts.market,
  "--position_state",
  deployment.contracts["position-state"],
  "--intent_registry",
  deployment.contracts["intent-registry"],
  "--circuit_id",
  bytes32(circuitKey("batch-match")),
], true);
invoke(deployment.contracts.liquidation, "init", [
  "--governance",
  deployment.contracts.governance,
  "--proof_ledger",
  deployment.contracts["proof-ledger"],
  "--market_contract",
  deployment.contracts.market,
  "--position_state",
  deployment.contracts["position-state"],
  "--circuit_id",
  bytes32(circuitKey("liquidation-check")),
], true);
invoke(deployment.contracts["conditional-order"], "init", [
  "--governance",
  deployment.contracts.governance,
  "--proof_ledger",
  deployment.contracts["proof-ledger"],
  "--market_contract",
  deployment.contracts.market,
  "--circuit_id",
  bytes32(circuitKey("conditional-close")),
], true);
invoke(deployment.contracts["position-close"], "init", [
  "--governance",
  deployment.contracts.governance,
  "--proof_ledger",
  deployment.contracts["proof-ledger"],
  "--conditional_order",
  deployment.contracts["conditional-order"],
  "--market_contract",
  deployment.contracts.market,
  "--position_state",
  deployment.contracts["position-state"],
  "--circuit_id",
  bytes32(circuitKey("position-close")),
], true);
invoke(deployment.contracts["disclosure-verifier"], "init", [
  "--governance",
  deployment.contracts.governance,
  "--proof_ledger",
  deployment.contracts["proof-ledger"],
  "--circuit_id",
  bytes32(circuitKey("disclosure")),
], true);
invoke(deployment.contracts.market, "set_funding_updater", [
  "--updater",
  deployment.contracts["funding-settlement"],
  "--enabled",
  "true",
]);
invoke(deployment.contracts["position-state"], "set_writer", [
  "--writer",
  deployment.contracts["batch-settlement"],
  "--enabled",
  "true",
]);
invoke(deployment.contracts["position-state"], "set_writer", [
  "--writer",
  deployment.contracts.liquidation,
  "--enabled",
  "true",
]);
invoke(deployment.contracts["position-state"], "set_writer", [
  "--writer",
  deployment.contracts["position-close"],
  "--enabled",
  "true",
]);

const withdrawDir = join(root, "circuits/withdraw/target/bb");
const publicInputs = join(withdrawDir, "public_inputs");
const proof = join(withdrawDir, "proof");
invoke(deployment.verifiers["withdraw-proof-verifier"], "verify_and_record", [
  "--public_inputs-file-path",
  publicInputs,
  "--proof_bytes-file-path",
  proof,
  "--public_input_hash",
  bytes32(hashFile(publicInputs)),
  "--proof_digest",
  bytes32(hashFile(proof)),
]);

console.log(JSON.stringify({ finalized: true, deployment: env.stellarDeploymentFile }, null, 2));

function readDeployment(): Deployment {
  const path = join(root, env.stellarDeploymentFile);
  if (!existsSync(path)) throw new Error(`missing deployment: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

function invoke(contractId: string, method: string, args: string[], allowFailure = false): string {
  const command = [
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
  const output = run(command, allowFailure);
  sleep(3500);
  return output;
}

function run(command: string[], allowFailure: boolean): string {
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    last = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.status === 0) {
      if (last.trim()) console.log(last.trim());
      return last;
    }
    if (allowFailure && /already initialized|AlreadyInitialized/.test(last)) {
      console.log(last.trim());
      return last;
    }
    sleep(6000);
  }
  if (allowFailure) {
    console.log(last.trim());
    return last;
  }
  throw new Error(`${command.join(" ")} failed\n${last}`);
}

function hashFile(path: string): Hex {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `0x${hash}`;
}

function bytes32(hex: Hex | string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
