import { createHash } from "node:crypto";
import type { Hex } from "@pnlx/protocol-types";

function normalize(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return `[${value.map(normalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, entry]) => `${key}:${normalize(entry)}`).join(",")}}`;
}

export function hashFields(domain: string, fields: unknown[]): Hex {
  const h = createHash("sha256");
  h.update("pnlx:");
  h.update(domain);
  h.update(":");
  h.update(fields.map(normalize).join("|"));
  return `0x${h.digest("hex")}`;
}
