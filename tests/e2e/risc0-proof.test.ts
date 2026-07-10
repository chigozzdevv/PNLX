import { describe, expect, test } from "bun:test";
import {
  RISC0_GROTH16_SEAL_BYTES,
  validateRisc0Seal,
} from "@/workers/risc0-matcher/risc0-proof";

const SELECTOR = "73c457ba";

describe("RISC0 Groth16 proof artifacts", () => {
  test("accepts a correctly sized seal with the deployed selector", () => {
    const seal = new Uint8Array(RISC0_GROTH16_SEAL_BYTES);
    seal.set(Buffer.from(SELECTOR, "hex"), 0);
    seal[seal.length - 1] = 1;
    expect(() => validateRisc0Seal(seal, SELECTOR)).not.toThrow();
  });

  test("rejects the cached 32-byte zero seal", () => {
    expect(() => validateRisc0Seal(new Uint8Array(32), SELECTOR)).toThrow(
      "must be 260 bytes; received 32",
    );
  });

  test("rejects a seal for a different verifier selector", () => {
    const seal = new Uint8Array(RISC0_GROTH16_SEAL_BYTES);
    seal.set(Buffer.from("00000001", "hex"), 0);
    expect(() => validateRisc0Seal(seal, SELECTOR)).toThrow(
      "seal selector mismatch",
    );
  });
});
