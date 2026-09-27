import { describe, expect, test } from "bun:test";
import { assertLinearRecoveredChain } from "../../scripts/operations/return-recovered-vault-note";
import type { VaultMakerAllocation } from "../../server/src/shared/vault-maker-backing";

const allocation = {
  noteCommitments: ["root"],
} as VaultMakerAllocation;

describe("recovered vault note ancestry", () => {
  test("accepts one fully spent chain ending at the recovered balance", () => {
    expect(() => assertLinearRecoveredChain(allocation, [
      { commitment: "root", amount: "100", status: "spent" },
      { commitment: "change", amount: "70", status: "spent", vaultParentCommitment: "root" },
      { commitment: "recovered", amount: "40", status: "spent", vaultParentCommitment: "change" },
    ], "recovered")).not.toThrow();
  });

  test("rejects a branch that could leave another note eligible", () => {
    expect(() => assertLinearRecoveredChain(allocation, [
      { commitment: "root", amount: "100", status: "spent" },
      { commitment: "left", amount: "70", status: "spent", vaultParentCommitment: "root" },
      { commitment: "right", amount: "20", status: "spent", vaultParentCommitment: "root" },
    ], "left")).toThrow();
  });

  test("rejects a note with an unspent descendant", () => {
    expect(() => assertLinearRecoveredChain(allocation, [
      { commitment: "root", amount: "100", status: "spent" },
      { commitment: "change", amount: "70", status: "available", vaultParentCommitment: "root" },
    ], "root")).toThrow();
  });
});
