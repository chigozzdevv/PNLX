import { createHash } from "node:crypto";
import { mod } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";

export type ContractPublicInput =
  | { kind: "field"; value: Hex }
  | { kind: "i128"; value: bigint }
  | { kind: "u128"; value: bigint };

const U128_MAX = (1n << 128n) - 1n;

export function contractPublicInputHash(inputs: ContractPublicInput[]): Hex {
  const hash = createHash("sha256");
  for (const input of inputs) {
    if (input.kind === "field") {
      hash.update(fieldBytes(input.value));
    } else if (input.kind === "u128") {
      hash.update(u128Bytes(input.value));
    } else {
      const negative = input.value < 0n;
      hash.update(u128Bytes(negative ? -input.value : input.value));
      hash.update(u128Bytes(negative ? 1n : 0n));
    }
  }
  return `0x${hash.digest("hex")}`;
}

export function publicField(value: Hex): ContractPublicInput {
  return { kind: "field", value };
}

export function publicI128(value: bigint): ContractPublicInput {
  return { kind: "i128", value };
}

export function publicU128(value: bigint): ContractPublicInput {
  return { kind: "u128", value };
}

function fieldBytes(value: Hex): Buffer {
  return bytes32(mod(BigInt(value)));
}

function u128Bytes(value: bigint): Buffer {
  if (value < 0n || value > U128_MAX) throw new Error("public u128 out of range");
  return bytes32(value);
}

function bytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error("public input field out of range");
  return Buffer.from(hex, "hex");
}
