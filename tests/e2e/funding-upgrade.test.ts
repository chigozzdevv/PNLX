import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCircuit } from "@pnlx/proof-system";
import { assertRisc0ProgramBinary, createFundingUpgradePlan, executeFundingUpgrade, fundingUpgradeTreeHash, upgradedFundingRegistry,
  type FundingDrainSnapshot, type FundingUpgradeCheckpoint, type FundingUpgradeEvidence, type FundingUpgradePlan,
  type FundingUpgradeRegistry, type UpgradeRunner } from "../../scripts/deploy/upgrade-funding";

const now = 1_000_000;
const hash = (value: Uint8Array | string): string => `0x${createHash("sha256").update(value).digest("hex")}`;
const hex = (byte: string): string => `0x${byte.repeat(64)}`;
const contract = (letter: string): string => `C${letter.repeat(55)}`;
// ProgramBinary::new(user_elf, kernel_elf).encode(): real SDK v3 header with
// short ELF payload stubs; the actual SDK/host image check is separately required.
const programFixture = () => Buffer.from("5230424601000000100000000100000008000000000005312e302e30040000007f454c467f454c46", "hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pnlx-funding-upgrade-"));
  const put = (path: string, bytes: Uint8Array | string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); return { path, sha256: hash(bytes) }; };
  put("contracts/funding-settlement/src/lib.rs", "funding-cycle authority binding");
  put("contracts/batch-settlement/src/lib.rs", "entry epoch binding");
  put("circuits/funding-update/Nargo.toml", '[package]\nname="funding_update"');
  put("circuits/funding-update/src/main.nr", "public cycle proof");
  put("risc0/batch-match/core/src/lib.rs", "public signed funding index");
  put("risc0/batch-match/image-id.json", JSON.stringify({ imageId: hex("2") }));
  put("vendor/stellar-risc0-verifier/contracts/groth16-verifier/parameters.json", "verified parameters");
  const artifacts = {
    fundingWasm: put("contracts/target/stellar/funding_settlement.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])),
    batchWasm: put("contracts/target/stellar/batch_settlement.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1])),
    fundingVerifierWasm: put("contracts/target/stellar/proof_verifier.wasm", Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 2])),
    fundingVk: put("circuits/funding-update/target/bb/vk", "unit fixture VK"),
    fundingBytecode: put("circuits/funding-update/target/funding_update.json", '{"bytecode":"unit fixture"}'),
    guestProgram: put("guest.bin", programFixture()),
    guestHost: put("guest-host", "unit fixture host"), guestSeal: put("seal.bin", Buffer.alloc(260, 1)),
    guestJournal: put("journal.bin", "public fixture journal"),
  };
  const registry: FundingUpgradeRegistry = { network: "testnet", source: "admin", sourceAddress: `G${"A".repeat(55)}`,
    upgradeAuthority: `G${"B".repeat(55)}`, contracts: Object.fromEntries([
      "governance", "funding-settlement", "batch-settlement", "position-state", "shielded-pool", "market", "risc0-router", "proof-ledger",
    ].map((name, index) => [name, contract(String.fromCharCode(65 + index))])), verifiers: {
      "funding-update-proof-verifier": contract("J"), "batch-match-risc0-verifier": contract("K"),
      "position-close-proof-verifier": contract("L"),
    }, wasmHashes: { "funding-settlement": hex("3"), "batch-settlement": hex("4"), "position-close": hex("5"),
      "funding-update-proof-verifier": hex("b"), "proof-verifier": hex("c") },
    risc0BatchMatchImageId: hex("6"), risc0BatchMatchVerifierHash: hex("7"), unrelated: { preserve: "this" } };
  const evidence: FundingUpgradeEvidence = { version: 1, network: "testnet", lockedBuild: true,
    old: { fundingWasmHash: hex("3"), batchWasmHash: hex("4"), fundingVerifierWasmHash: hex("b"), fundingVerifierHash: hex("8"), batchImageId: hex("6"), batchVerifierHash: hex("7") },
    artifacts, sourceHashes: { contracts: fundingUpgradeTreeHash(join(root, "contracts")),
      fundingCircuit: loadCircuit(root, "funding-update").sourceHash, guest: fundingUpgradeTreeHash(join(root, "risc0/batch-match")) },
    guest: { imageId: hex("2"), computedImageId: hex("2"), developmentMode: false, productionReceiptVerified: true },
    collateralToken: contract("M"), marketId: "xlm-usd-perp" };
  const plan = createFundingUpgradePlan(registry, evidence, { root });
  return { root, registry, evidence, plan };
}

function withFixture(fn: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture(); try { fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

function harness(f: ReturnType<typeof fixture>) {
  const plan = f.plan;
  const key = (command: { argv: string[] }): string => JSON.stringify(command.argv);
  const values = new Map<string, string>();
  for (const guard of [...plan.initialGuards, ...plan.preflights]) values.set(key(guard.command), guard.expected);
  for (const step of plan.steps) for (const guard of step.guards) values.set(key(guard.command), guard.old ?? "false");
  for (const guard of plan.invariants) values.set(key(guard.command), guard.id.endsWith("count") ? "30" : guard.id === "state:pool-balance" ? "1000000000" : guard.id === "state:funding-index" ? "-7" : hex("9"));
  const state = { values, sends: [] as string[], saved: undefined as FundingUpgradeCheckpoint | undefined,
    failStep: "", landOnFailure: false, failSave: false, driftAfter: "", corruptVerifierState: false };
  const drain: FundingDrainSnapshot = { version: 1, network: "testnet", identityHash: plan.identityHash, capturedAt: now,
    workersStopped: { batch: true, funding: true, liquidation: true, protection: true, makers: true },
    pending: { batch: 0, funding: 0, proofs: 0, closes: 0, intents: 0 } };
  const apply = (id: string) => { for (const guard of plan.steps.find((step) => step.id === id)!.guards) values.set(key(guard.command), guard.expected); };
  const runner: UpgradeRunner = { now: () => now, drain: () => drain,
    save: (checkpoint) => { if (state.failSave && Object.values(checkpoint.steps).includes("attempted")) throw new Error("checkpoint disk failure"); state.saved = structuredClone(checkpoint); },
    run: (command) => {
      const step = plan.steps.find((step) => key(step.command) === key(command));
      if (step) {
        state.sends.push(step.id);
        if (step.id !== state.failStep || state.landOnFailure) apply(step.id);
        if (step.id === "upgrade:funding-update-proof-verifier" && state.corruptVerifierState) {
          values.set(key(plan.steps.find((item) => item.id === "rotate:funding-vk")!.guards[0].command), hex("d"));
        }
        if (step.id === state.driftAfter) values.set(key(plan.invariants[0].command), hex("a"));
        return { status: step.id === state.failStep ? 1 : 0, stdout: "null" };
      }
      const guard = [...plan.initialGuards, ...plan.preflights, ...plan.invariants, ...plan.finalGuards].find((guard) => key(guard.command) === key(command));
      if (!guard) throw new Error("unexpected command");
      const value = values.get(key(command))!;
      if (guard.binary) {
        if (value === "absent") return { status: 1, stdout: "", stderr: "contract code not found" };
        const artifact = guard.id === "code:funding-settlement" ? f.evidence.artifacts.fundingWasm
          : guard.id === "code:batch-settlement" ? f.evidence.artifacts.batchWasm : f.evidence.artifacts.fundingVerifierWasm;
        return { status: 0, stdout: readFileSync(join(f.root, artifact.path)) };
      }
      return { status: 0, stdout: JSON.stringify(value === "null" ? null : value) };
    } };
  return { state, runner, drain, apply, key };
}

describe("funding-only upgrade", () => {
  test("accepts the SDK ProgramBinary envelope and rejects raw ELF or truncated containers", () => {
    expect(() => assertRisc0ProgramBinary(programFixture())).not.toThrow();
    for (const invalid of [Buffer.from([127, 69, 76, 70, 1, 2, 3]), programFixture().subarray(0, 31),
      programFixture().subarray(0, 36), Buffer.from("R0BF"), Buffer.from(programFixture())]) {
      if (invalid.length === programFixture().length) invalid.writeUInt32LE(2, 4);
      expect(() => assertRisc0ProgramBinary(invalid)).toThrow("ProgramBinary");
    }
    withFixture((f) => {
      const path = join(f.root, f.evidence.artifacts.guestProgram.path);
      const rawElf = Buffer.from([127, 69, 76, 70, 1, 2, 3]);
      writeFileSync(path, rawElf); f.evidence.artifacts.guestProgram.sha256 = hash(rawElf);
      expect(() => createFundingUpgradePlan(f.registry, f.evidence, { root: f.root })).toThrow("ProgramBinary");
    });
  });

  test("the default CLI prints its plan without looking up signers or starting commands", () => withFixture((f) => {
    const registry = join(f.root, "registry.json"), evidence = join(f.root, "evidence.json");
    writeFileSync(registry, JSON.stringify(f.registry)); writeFileSync(evidence, JSON.stringify(f.evidence));
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/deploy/upgrade-funding.ts"), "--registry", registry, "--evidence", evidence], {
      cwd: f.root, encoding: "utf8", env: { ...process.env, PATH: join(f.root, "no-command-path") },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, identityHash: f.plan.identityHash });
  }));

  test("the dry plan upgrades only the two settlements and the existing funding verifier", () => withFixture(({ plan }) => {
    expect(plan.steps.map((step) => step.id)).toEqual(["upload:funding-settlement", "upgrade:funding-settlement", "upload:batch-settlement", "upgrade:batch-settlement",
      "upload:funding-update-proof-verifier", "upgrade:funding-update-proof-verifier",
      "rotate:funding-vk", "bind:funding-vk", "rotate:batch-image", "bind:batch-image"]);
    const commands = plan.steps.map((step) => step.command.argv.join(" ")).join("\n");
    for (const forbidden of [" contract deploy ", " set_paused ", " reset_for_poseidon2 ", " set_writer ", " advance_funding ", " settle "]) expect(commands).not.toContain(forbidden);
    expect(plan.preflights[1].command.argv).toContain("no");
    expect(plan.steps.find((step) => step.id === "rotate:batch-image")!.command.argv).toContain("--verifier_hash");
  }));

  test("existing positions, roots, balances and unrelated deployment entries survive", () => withFixture((f) => {
    const h = harness(f);
    const completed = executeFundingUpgrade(f.plan, h.runner);
    expect(h.state.sends).toEqual(f.plan.steps.map((step) => step.id));
    expect(completed.baseline["state:position-count"]).toBe("30");
    expect(completed.baseline["state:pool-balance"]).toBe("1000000000");
    expect(Object.values(completed.steps).every((status) => status === "verified")).toBe(true);
    const next = upgradedFundingRegistry(f.plan);
    expect(next.contracts).toEqual(f.registry.contracts);
    expect(next.verifiers).toEqual(f.registry.verifiers);
    expect(next.unrelated).toEqual(f.registry.unrelated);
    expect(next.wasmHashes["position-close"]).toBe(f.registry.wasmHashes["position-close"]);
    expect(next.wasmHashes["proof-verifier"]).toBe(f.registry.wasmHashes["proof-verifier"]);
    expect(next.wasmHashes["funding-update-proof-verifier"]).toBe(f.evidence.artifacts.fundingVerifierWasm.sha256);
    h.state.sends.length = 0;
    executeFundingUpgrade(f.plan, h.runner, h.state.saved);
    expect(h.state.sends).toEqual([]);
    const resumedPlan = createFundingUpgradePlan(next, f.evidence, { root: f.root });
    expect(resumedPlan.fingerprint).toBe(f.plan.fingerprint);
  }));

  test("active workers, pending attempts, stale drain evidence and signer mismatch block all sends", () => withFixture((f) => {
    for (const kind of ["worker", "pending", "stale", "signer"]) {
      const h = harness(f);
      if (kind === "worker") h.drain.workersStopped.funding = false;
      if (kind === "pending") h.drain.pending.funding = 1;
      if (kind === "stale") h.drain.capturedAt = now - 300_001;
      if (kind === "signer") h.state.values.set(h.key(f.plan.initialGuards[0].command), `G${"Z".repeat(55)}`);
      expect(() => executeFundingUpgrade(f.plan, h.runner)).toThrow();
      expect(h.state.sends).toEqual([]);
    }
  }));

  test("unknown code identity or checkpoint drift never starts a switch", () => withFixture((f) => {
    const h = harness(f);
    const wasm = f.plan.steps[1].guards[0];
    h.state.values.set(h.key(wasm.command), hex("e"));
    expect(() => executeFundingUpgrade(f.plan, h.runner)).toThrow("unrecognized live identity");
    expect(h.state.sends).toEqual([]);
    expect(() => executeFundingUpgrade(f.plan, h.runner, { fingerprint: "changed", baseline: {}, steps: {} })).toThrow("fingerprint");
    expect(() => executeFundingUpgrade(f.plan, h.runner, { fingerprint: f.plan.fingerprint, baseline: {}, steps: {} })).toThrow("malformed");
  }));

  test("a failed production receipt or live read prevents every upgrade", () => withFixture((f) => {
    const h = harness(f);
    h.state.values.set(h.key(f.plan.preflights[1].command), "invalid receipt");
    expect(() => executeFundingUpgrade(f.plan, h.runner)).toThrow("production-receipt");
    expect(h.state.sends).toEqual([]);
    const original = h.runner.run;
    h.runner.run = (command) => h.key(command) === h.key(f.plan.initialGuards[2].command)
      ? { status: 1, stdout: "", stderr: "RPC unavailable" } : original(command);
    expect(() => executeFundingUpgrade(f.plan, h.runner)).toThrow("read failed");
    expect(h.state.sends).toEqual([]);
  }));

  test("an ambiguous submission stays held until its exact target state is observed", () => withFixture((f) => {
    const h = harness(f); h.state.failStep = "upgrade:funding-settlement";
    expect(() => executeFundingUpgrade(f.plan, h.runner)).toThrow("submission uncertain");
    expect(h.state.saved?.steps["upgrade:funding-settlement"]).toBe("attempted");
    h.state.sends.length = 0;
    expect(() => executeFundingUpgrade(f.plan, h.runner, h.state.saved)).toThrow("reconcile before retrying");
    expect(h.state.sends).toEqual([]);
    h.apply("upgrade:funding-settlement");
    h.state.failStep = "";
    executeFundingUpgrade(f.plan, h.runner, h.state.saved);
    expect(h.state.sends).not.toContain("upgrade:funding-settlement");
    expect(h.state.saved?.steps["upgrade:funding-settlement"]).toBe("verified");
  }));

  test("a failed durable checkpoint prevents submission", () => withFixture((f) => {
    const h = harness(f); h.state.failSave = true;
    expect(() => executeFundingUpgrade(f.plan, h.runner)).toThrow("checkpoint disk failure");
    expect(h.state.sends).toEqual([]);
  }));

  test("the funding verifier code switch preserves its old key and lifecycle before rotation", () => withFixture((f) => {
    const h = harness(f); h.state.corruptVerifierState = true;
    expect(() => executeFundingUpgrade(f.plan, h.runner)).toThrow("preserve:funding-vk");
    expect(h.state.sends).toContain("upgrade:funding-update-proof-verifier");
    expect(h.state.sends).not.toContain("rotate:funding-vk");
    expect(h.state.saved?.steps["upgrade:funding-update-proof-verifier"]).toBe("attempted");
    expect(f.plan.steps.find((step) => step.id === "upgrade:funding-update-proof-verifier")!.transitionGuards!.map((guard) => guard.id))
      .toEqual(["preserve:funding-vk", "preserve:funding-namespace", "preserve:funding-governance", "preserve:funding-ledger", "preserve:funding-circuit"]);
  }));

  test("financial-state drift halts the upgrade without attempting to restore money or roots", () => withFixture((f) => {
    const h = harness(f); h.state.driftAfter = "upgrade:funding-settlement";
    expect(() => executeFundingUpgrade(f.plan, h.runner)).toThrow("financial state changed");
    expect(h.state.sends).toEqual(["upload:funding-settlement", "upgrade:funding-settlement"]);
  }));

  test("artifacts, source fingerprints and production guest evidence must match", () => {
    for (const kind of ["wasm", "source", "dev", "pin", "vk"]) withFixture((f) => {
      if (kind === "wasm") writeFileSync(join(f.root, f.evidence.artifacts.fundingWasm.path), "changed");
      if (kind === "source") writeFileSync(join(f.root, "contracts/funding-settlement/src/lib.rs"), "changed");
      if (kind === "dev") (f.evidence.guest as { developmentMode: boolean }).developmentMode = true;
      if (kind === "pin") f.evidence.guest.computedImageId = hex("f");
      if (kind === "vk") f.evidence.old.fundingVerifierHash = f.evidence.artifacts.fundingVk.sha256;
      expect(() => createFundingUpgradePlan(f.registry, f.evidence, { root: f.root })).toThrow();
    });
  });
});
