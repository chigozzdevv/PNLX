import type { Hex } from "@pnlx/protocol-types";
import { hashFields } from "./hash";

export function nullifier(spendSecret: string, rho: string): Hex {
  return hashFields("nullifier", [spendSecret, rho]);
}
