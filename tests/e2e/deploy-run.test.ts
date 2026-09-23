import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { circuitKey } from "@pnlx/proof-system";
import { RISC0_BATCH_MATCH_IMAGE_ID } from "@/workers/risc0-matcher/risc0-proof";
import { assertCompiledRisc0ImageId, commandPlan, deploy, parseOptions, reusableVaultFromRegistry } from "../../scripts/deploy/run";

describe("deployment runner", () => {
  test("refuses to replace the active deployment registry before any deployment", () => {
    const options = parseOptions(["--network", "testnet", "--out", "deployments/testnet.json"]);
    expect(() => deploy(options)).toThrow("deployment registry already exists");
  });

  test("requires a saved registry before deploying to a network", () => {
    expect(() => deploy(parseOptions(["--network", "testnet"]))).toThrow(
      "network deployment requires --out",
    );
  });

  test("requires a separate upgrade authority before a network deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "pnlx-deploy-"));
    try {
      expect(() => deploy(parseOptions([
        "--network", "testnet", "--out", join(root, "testnet-fees.json"),
      ]))).toThrow("network deployment requires --upgrade-authority");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves an unfinished deployment record instead of redeploying over it", () => {
    const root = mkdtempSync(join(tmpdir(), "pnlx-deploy-"));
    try {
      const out = join(root, "testnet-fees.json");
      writeFileSync(`${out}.partial`, "{}");
      expect(() => deploy(parseOptions([
        "--network", "testnet", "--out", out,
        "--upgrade-authority", `G${"A".repeat(55)}`,
      ]))).toThrow("unfinished deployment registry already exists");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a compiled RISC0 guest that differs from the deployment image", () => {
    expect(() => assertCompiledRisc0ImageId(`0x${"ff".repeat(32)}`)).toThrow(
      "compiled RISC0 image id mismatch",
    );
    expect(() => assertCompiledRisc0ImageId(RISC0_BATCH_MATCH_IMAGE_ID)).not.toThrow();
    expect(() => assertCompiledRisc0ImageId(`${RISC0_BATCH_MATCH_IMAGE_ID}\nCompiling guest\nFinished release build`)).not.toThrow();
  });

  test("reuses only a vault from a registry on the target network", () => {
    const options = parseOptions([
      "--network", "testnet",
      "--out", "deployments/testnet-fees.json",
      "--reuse-vault-from", "deployments/testnet.json",
    ]);
    expect(options.reuseVaultFrom).toBe("deployments/testnet.json");
    expect(reusableVaultFromRegistry(options.reuseVaultFrom!, options.network)).toBe(
      "CAU2RWJFKWZIRWLTO734X2BSVIAH22WHCIRRYIBLQPHIUPPFQ6U5MMTQ",
    );
    expect(() => reusableVaultFromRegistry(options.reuseVaultFrom!, "local")).toThrow(
      "vault source registry network mismatch",
    );
    const plan = commandPlan({ ...options, dryRun: true, smoke: false });
    expect(plan.some((command) => command.includes("CAU2RWJFKWZIRWLTO734X2BSVIAH22WHCIRRYIBLQPHIUPPFQ6U5MMTQ") && command.includes("asset"))).toBe(true);
    expect(plan.some((command) => command.includes("CAU2RWJFKWZIRWLTO734X2BSVIAH22WHCIRRYIBLQPHIUPPFQ6U5MMTQ") && command.includes("upgrade_authority"))).toBe(true);
  });

  test("builds localnet deployment and verifier smoke commands", () => {
    const options = parseOptions([
      "--dry-run",
      "--network",
      "local",
      "--source",
      "alice",
      "--alias-prefix",
      "pnlx-test",
      "--setup-local",
    ]);
    const commands = commandPlan(options);
    const rendered = commands.map((command) => command.join(" "));

    expect(rendered.some((command) => command.includes("container start local"))).toBe(true);
    expect(rendered.some((command) => command.includes("contract deploy") && command.includes("--network-passphrase Standalone Network ; February 2017"))).toBe(true);
    expect(rendered.some((command) => command.includes("contract deploy"))).toBe(true);
    expect(rendered.some((command) => command.includes("proof_verifier.wasm"))).toBe(true);
    expect(rendered.some((command) => command.includes("position_state.wasm"))).toBe(true);
    expect(rendered.some((command) => command.includes("position-state") && command.includes("set_writer"))).toBe(true);
    expect(rendered.filter((command) => command.includes("set_upgrade_authority")).length).toBe(3);
    expect(rendered.some((command) => command.includes("verify_and_record"))).toBe(true);
    expect(
      rendered.some((command) =>
        command.includes("batch-match-risc0-verifier") &&
        command.includes(`--image_id ${RISC0_BATCH_MATCH_IMAGE_ID.slice(2)}`),
      ),
    ).toBe(true);
    expect(
      rendered.some((command) =>
        command.includes(`--circuit_id ${circuitKey("withdraw").slice(2)}`),
      ),
    ).toBe(true);
    expect(
      rendered.some((command) =>
        command.includes("shielded-pool") &&
        command.includes("init") &&
        command.includes(`--deposit_circuit_id ${circuitKey("deposit-note").slice(2)}`) &&
        command.includes(`--withdraw_circuit_id ${circuitKey("withdraw").slice(2)}`),
      ),
    ).toBe(true);
  });
});
