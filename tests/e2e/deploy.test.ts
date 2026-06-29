import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { circuitKey } from "@merkl/proof-system";
import { createDeployManifest } from "../../scripts/deploy/manifest";

function buildContracts(): void {
  const result = spawnSync(
    "stellar",
    [
      "contract",
      "build",
      "--manifest-path",
      "contracts/Cargo.toml",
      "--out-dir",
      "contracts/target/stellar",
      "--locked",
      "--optimize=false",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
}

function buildProofs(): void {
  const result = spawnSync("bun", ["scripts/proof/build.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
}

let artifactsReady = false;

function ensureArtifacts(): void {
  if (artifactsReady) return;
  buildContracts();
  buildProofs();
  artifactsReady = true;
}

function interfaceNames(wasmPath: string): string[] {
  const result = spawnSync(
    "stellar",
    ["contract", "info", "interface", "--wasm", wasmPath, "--output", "json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  const specs = JSON.parse(result.stdout) as Record<string, { name?: string }>[];

  return specs
    .map((entry) => entry.function_v0?.name)
    .filter((name): name is string => typeof name === "string");
}

describe("deployment manifest", () => {
  test("binds contract artifacts to proof verifier registry", () => {
    ensureArtifacts();

    const manifest = createDeployManifest();
    const contractNames = manifest.contracts.map((contract) => contract.name);
    const shieldedPoolInit = manifest.initPlan.find((item) => item.contract === "shielded-pool");
    const marketInit = manifest.initPlan.find((item) => item.contract === "market");
    const fundingSettlementInit = manifest.initPlan.find(
      (item) => item.contract === "funding-settlement",
    );
    const fundingUpdater = manifest.initPlan.find(
      (item) => item.contract === "market" && item.method === "set_funding_updater",
    );
    const positionStateInit = manifest.initPlan.find((item) => item.contract === "position-state" && item.method === "init");
    const positionStateWriters = manifest.initPlan.filter(
      (item) => item.contract === "position-state" && item.method === "set_writer",
    );
    const batchInit = manifest.initPlan.find((item) => item.contract === "batch-settlement");
    const liquidationInit = manifest.initPlan.find((item) => item.contract === "liquidation");
    const conditionalOrderInit = manifest.initPlan.find(
      (item) => item.contract === "conditional-order",
    );
    const positionCloseInit = manifest.initPlan.find((item) => item.contract === "position-close");
    const disclosureInit = manifest.initPlan.find((item) => item.contract === "disclosure-verifier");
    const proofLedgerInit = manifest.initPlan.find((item) => item.contract === "proof-ledger");

    expect(contractNames).toEqual([
      "governance",
      "proof-ledger",
      "price-oracle",
      "position-state",
      "shielded-pool",
      "intent-registry",
      "conditional-order",
      "market",
      "funding-settlement",
      "batch-settlement",
      "liquidation",
      "position-close",
      "disclosure-verifier",
      "proof-verifier",
    ]);
    for (const contract of manifest.contracts) {
      expect(contract.wasmHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(manifest.verifiers).toHaveLength(11);
    expect(manifest.verifiers.every((verifier) => verifier.verifierSource === "artifact")).toBe(true);
    expect(
      manifest.verifiers.every((verifier) => verifier.verifierAuthority.endsWith("-proof-verifier")),
    ).toBe(true);
    expect(manifest.verifiers.every((verifier) => verifier.verifierContract === "proof-verifier")).toBe(
      true,
    );
    expect(manifest.verifiers.every((verifier) => verifier.vkPath.endsWith("target/bb/vk"))).toBe(true);
    expect(proofLedgerInit?.args).toEqual(["governance"]);
    expect(shieldedPoolInit?.args).toEqual([
      "governance",
      "proof-ledger",
      circuitKey("deposit-note"),
      circuitKey("withdraw"),
    ]);
    expect(marketInit?.args).toEqual(["governance"]);
    expect(fundingSettlementInit?.args).toEqual([
      "governance",
      "proof-ledger",
      "market",
      circuitKey("funding-update"),
    ]);
    expect(positionStateInit?.args).toEqual(["governance", "initialPositionRoot"]);
    expect(batchInit?.args).toEqual([
      "governance",
      "proof-ledger",
      "market",
      "position-state",
      "intent-registry",
      circuitKey("batch-match"),
    ]);
    expect(liquidationInit?.args).toEqual([
      "governance",
      "proof-ledger",
      "market",
      "position-state",
      circuitKey("liquidation-check"),
    ]);
    expect(conditionalOrderInit?.args).toEqual([
      "governance",
      "proof-ledger",
      "market",
      circuitKey("conditional-close"),
    ]);
    expect(positionCloseInit?.args).toEqual([
      "governance",
      "proof-ledger",
      "conditional-order",
      "market",
      "position-state",
      circuitKey("position-close"),
    ]);
    expect(positionStateWriters.map((item) => item.args)).toEqual([
      ["batch-settlement", true],
      ["liquidation", true],
      ["position-close", true],
    ]);
    expect(fundingUpdater?.args).toEqual(["funding-settlement", true]);
    expect(disclosureInit?.args).toEqual(["governance", "proof-ledger", circuitKey("disclosure")]);
  }, 120_000);

  test("keeps governance exports out of proof-consuming contracts", () => {
    ensureArtifacts();

    const manifest = createDeployManifest();
    const forbidden = ["admin", "paused", "set_paused", "set_verifier", "verifier"];
    const proofContracts = [
      "shielded-pool",
      "batch-settlement",
      "funding-settlement",
      "liquidation",
      "conditional-order",
      "position-close",
      "disclosure-verifier",
    ];

    for (const name of proofContracts) {
      const contract = manifest.contracts.find((item) => item.name === name);
      expect(contract).toBeTruthy();

      const names = interfaceNames(contract!.path);
      for (const forbiddenName of forbidden) {
        expect(names).not.toContain(forbiddenName);
      }
    }
  }, 120_000);
});
