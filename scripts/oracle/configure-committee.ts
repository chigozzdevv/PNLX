import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../../server/src/config/env";

interface Deployment {
  contracts: Record<string, string>;
  sourceAddress: string;
}

const root = process.cwd();
const env = loadEnv();
const deployment = readDeployment();
const oracleContract = env.oracleContractId || deployment.contracts["price-oracle"];
const publishers = resolvePublishers();

if (!oracleContract) {
  throw new Error("missing ORACLE_CONTRACT_ID or deployed price-oracle contract");
}
if (env.oracleCommitteeThreshold < 2) {
  throw new Error("ORACLE_COMMITTEE_THRESHOLD must be at least 2");
}
if (publishers.length < env.oracleCommitteeThreshold) {
  throw new Error("not enough oracle publishers for configured threshold");
}

invoke(env.stellarSource, oracleContract, "configure_committee", [
  "--admin",
  deployment.sourceAddress,
  "--threshold",
  String(env.oracleCommitteeThreshold),
  "--max_timestamp_age",
  String(env.oracleCommitteeMaxAgeSeconds),
  "--max_deviation_bps",
  String(env.oracleCommitteeMaxDeviationBps),
]);

for (const publisher of publishers) {
  invoke(env.stellarSource, oracleContract, "set_publisher", [
    "--admin",
    deployment.sourceAddress,
    "--publisher",
    publisher.address,
    "--enabled",
    "true",
  ]);
}

console.log(JSON.stringify({
  configured: true,
  oracleContract,
  publishers,
  threshold: env.oracleCommitteeThreshold,
}, null, 2));

function readDeployment(): Deployment {
  const path = join(root, env.stellarDeploymentFile);
  if (!existsSync(path)) throw new Error(`missing deployment: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

function resolvePublishers(): Array<{ address: string; source: string }> {
  const sources = env.oraclePublisherSources.length > 0
    ? env.oraclePublisherSources
    : env.oraclePublisherAddresses;
  if (sources.length === 0) {
    throw new Error("ORACLE_PUBLISHER_SOURCES or ORACLE_PUBLISHER_ADDRESSES is required");
  }
  if (env.oraclePublisherAddresses.length > 0 && sources.length < env.oraclePublisherAddresses.length) {
    throw new Error("ORACLE_PUBLISHER_SOURCES must include one source for each address");
  }

  return sources.map((source, index) => {
    const configured = env.oraclePublisherAddresses[index];
    return {
      address: configured || resolveAddress(source),
      source,
    };
  });
}

function resolveAddress(source: string): string {
  if (/^G[A-Z0-9]{55}$/.test(source)) return source;
  const output = run(["stellar", "keys", "address", source], false);
  const address = output.match(/\bG[A-Z0-9]{55}\b/)?.[0];
  if (!address) throw new Error(`could not resolve publisher source ${source}`);
  return address;
}

function invoke(source: string, contractId: string, method: string, args: string[]): string {
  const command = [
    "stellar",
    "contract",
    "invoke",
    "--id",
    contractId,
    "--source",
    source,
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
  const output = run(command, true);
  sleep(3500);
  return output;
}

function run(command: string[], retry: boolean): string {
  let last = "";
  const attempts = retry ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
    if (/txbadseq|tx_bad_seq|try_again_later|timeout|rate limit/i.test(last)) {
      sleep(3000 * attempt);
      continue;
    }
    break;
  }
  throw new Error(`${command.join(" ")} failed\n${last}`);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
