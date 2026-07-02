import { describe, expect, test } from "bun:test";
import { circuitKey } from "@pnlx/proof-system";
import { commandPlan, parseOptions } from "../../scripts/deploy/run";

describe("deployment runner", () => {
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
    expect(rendered.some((command) => command.includes("contract deploy"))).toBe(true);
    expect(rendered.some((command) => command.includes("proof_verifier.wasm"))).toBe(true);
    expect(rendered.some((command) => command.includes("position_state.wasm"))).toBe(true);
    expect(rendered.some((command) => command.includes("position-state") && command.includes("set_writer"))).toBe(true);
    expect(rendered.some((command) => command.includes("verify_and_record"))).toBe(true);
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
