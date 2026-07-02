import type { Hex } from "@pnlx/protocol-types";
import { hashFields } from "./hash";

export const EMPTY_ROOT = hashFields("merkle-empty", []);

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(hashFields("merkle-node", [left, right]));
    }
    level = next;
  }
  return level[0];
}
