import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { circuitKey, loadCircuits, verifierEntry } from "@pnlx/proof-system";
import type { Hex } from "@pnlx/protocol-types";
import {
  RISC0_BATCH_MATCH_CIRCUIT_HASH,
  RISC0_BATCH_MATCH_CIRCUIT_ID,
  RISC0_BATCH_MATCH_IMAGE_ID,
  RISC0_BATCH_MATCH_CIRCUIT_KEY,
  RISC0_STELLAR_VERIFIER_HASH,
} from "@/workers/risc0-matcher/risc0-proof";

const CONTRACTS = [
  ["governance", "governance.wasm"],
  ["proof-ledger", "proof_ledger.wasm"],
  ["price-oracle", "price_oracle.wasm"],
  ["position-state", "position_state.wasm"],
  ["shielded-pool", "shielded_pool.wasm"],
  ["intent-registry", "intent_registry.wasm"],
  ["conditional-order", "conditional_order.wasm"],
  ["market", "market.wasm"],
  ["funding-settlement", "funding_settlement.wasm"],
  ["batch-settlement", "batch_settlement.wasm"],
  ["liquidation", "liquidation.wasm"],
  ["position-close", "position_close.wasm"],
  ["disclosure-verifier", "disclosure_verifier.wasm"],
  ["proof-verifier", "proof_verifier.wasm"],
  ["risc0-proof-verifier", "risc0_proof_verifier.wasm"],
] as const;

const RISC0_VERIFIER_STACK_CONTRACTS = [
  ["risc0-router", "risc0_router"],
  ["risc0-groth16-verifier", "groth16_verifier"],
  ["risc0-emergency-stop", "emergency_stop"],
] as const;

interface ManifestOptions {
  requireContracts?: boolean;
  requireVerifierKeys?: boolean;
}

function hashFile(path: string): Hex {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  return `0x${hash}`;
}

export function createDeployManifest(root = process.cwd(), options: ManifestOptions = {}) {
  const requireContracts = options.requireContracts ?? true;
  const requireVerifierKeys = options.requireVerifierKeys ?? true;
  const contractDir = join(root, "contracts/target/stellar");
  const contracts = CONTRACTS.map(([name, file]) => {
    const path = join(contractDir, file);
    if (!existsSync(path) && requireContracts) throw new Error(`missing contract wasm: ${path}`);

    return {
      name,
      file,
      path,
      wasmHash: existsSync(path) ? hashFile(path) : `0x${"0".repeat(64)}`,
    };
  });
  const risc0VerifierStackDir = join(
    root,
    "vendor/stellar-risc0-verifier/target/wasm32v1-none/release",
  );
  const risc0VerifierStack = RISC0_VERIFIER_STACK_CONTRACTS.map(([name, wasmName]) => {
    const optimizedPath = join(risc0VerifierStackDir, `${wasmName}.optimized.wasm`);
    const releasePath = join(risc0VerifierStackDir, `${wasmName}.wasm`);
    const path = existsSync(optimizedPath) ? optimizedPath : releasePath;
    if (!existsSync(path) && requireContracts) throw new Error(`missing RISC0 verifier stack wasm: ${path}`);

    return {
      name,
      file: `${wasmName}.wasm`,
      path,
      wasmHash: existsSync(path) ? hashFile(path) : `0x${"0".repeat(64)}`,
    };
  });

  const noirVerifiers = Array.from(loadCircuits(root).values()).map((circuit) => {
    const entry = verifierEntry(circuit);
    const vkPath = join(root, circuit.dir, "target/bb/vk");
    if (requireVerifierKeys && !existsSync(vkPath)) {
      throw new Error(`missing verifier key: ${vkPath}`);
    }

    return {
      circuitId: circuit.id,
      circuitKey: entry.circuitId,
      circuitHash: circuit.sourceHash,
      imageId: undefined,
      verifierHash: entry.verifierHash,
      verifierAuthority: `${circuit.id}-proof-verifier`,
      verifierContract: "proof-verifier",
      verifierSource: circuit.verifierSource,
      vkPath,
    };
  });
  const verifiers = [
    ...noirVerifiers,
    {
      circuitHash: RISC0_BATCH_MATCH_CIRCUIT_HASH,
      circuitId: RISC0_BATCH_MATCH_CIRCUIT_ID,
      circuitKey: RISC0_BATCH_MATCH_CIRCUIT_KEY,
      imageId: RISC0_BATCH_MATCH_IMAGE_ID,
      verifierAuthority: `${RISC0_BATCH_MATCH_CIRCUIT_ID}-risc0-verifier`,
      verifierContract: "risc0-proof-verifier",
      verifierHash: RISC0_STELLAR_VERIFIER_HASH,
      verifierSource: "risc0-router",
      vkPath: "",
    },
  ];

  return {
    generatedBy: "scripts/deploy/manifest.ts",
    contracts,
    risc0VerifierStack,
    verifiers,
    initPlan: [
      { contract: "governance", method: "init", args: ["admin"] },
      { contract: "proof-ledger", method: "init", args: ["governance"] },
      { contract: "proof-verifier", method: "deploy", repeat: "verifiers" },
      { contract: "governance", method: "set_verifier", repeat: "verifiers" },
      {
        contract: "proof-verifier",
        method: "init",
        repeat: "verifiers",
        args: ["governance", "proof-ledger", "circuitKey", "verifierHash", "vkPath"],
      },
      {
        contract: "shielded-pool",
        method: "init",
        args: ["governance", "proof-ledger", circuitKey("deposit-note"), circuitKey("withdraw")],
      },
      {
        contract: "market",
        method: "init",
        args: ["governance"],
      },
      {
        contract: "funding-settlement",
        method: "init",
        args: ["governance", "proof-ledger", "market", circuitKey("funding-update")],
      },
      {
        contract: "position-state",
        method: "init",
        args: ["governance"],
      },
      {
        contract: "batch-settlement",
        method: "init",
        args: [
          "governance",
          "proof-ledger",
          "market",
          "position-state",
          "shielded-pool",
          "intent-registry",
          RISC0_BATCH_MATCH_CIRCUIT_KEY,
        ],
      },
      {
        contract: "liquidation",
        method: "init",
        args: ["governance", "proof-ledger", "market", "position-state", circuitKey("liquidation-check")],
      },
      {
        contract: "conditional-order",
        method: "init",
        args: ["governance", "proof-ledger", "market", circuitKey("conditional-close")],
      },
      {
        contract: "position-close",
        method: "init",
        args: [
          "governance",
          "proof-ledger",
          "conditional-order",
          "market",
          "position-state",
          circuitKey("position-close"),
        ],
      },
      {
        contract: "position-state",
        method: "set_writer",
        args: ["batch-settlement", true],
      },
      {
        contract: "shielded-pool",
        method: "set_writer",
        args: ["batch-settlement", true],
      },
      {
        contract: "position-state",
        method: "set_writer",
        args: ["liquidation", true],
      },
      {
        contract: "position-state",
        method: "set_writer",
        args: ["position-close", true],
      },
      {
        contract: "market",
        method: "set_funding_updater",
        args: ["funding-settlement", true],
      },
      {
        contract: "disclosure-verifier",
        method: "init",
        args: ["governance", "proof-ledger", circuitKey("disclosure")],
      },
    ],
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(createDeployManifest(), null, 2));
}
