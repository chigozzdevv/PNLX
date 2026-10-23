import { positionSecrets } from "@pnlx/crypto";
import type { Hex, PrivateMatchIntent, Side } from "@pnlx/protocol-types";
import { createCircuitPositionNote } from "@pnlx/sdk";

export function reconstructSmokePosition(input: {
  entryPrice: bigint;
  fundingIndex: bigint;
  margin: bigint;
  marketId: string;
  positionCommitments: Hex[];
  side: Side;
  size: bigint;
  source: Pick<PrivateMatchIntent, "marketId" | "ownerCommitment" | "ownerDigest" | "positionSeed">;
}) {
  if (!input.source.positionSeed || !input.source.ownerDigest || input.source.marketId !== input.marketId) {
    throw new Error("Private smoke position authority is unavailable");
  }
  for (let fillIndex = 0; fillIndex < input.positionCommitments.length; fillIndex += 1) {
    const secrets = positionSecrets(input.source.positionSeed, fillIndex);
    const position = createCircuitPositionNote({
      ...input, ...secrets, blindingDigest: secrets.blinding,
      owner: input.source.ownerCommitment, ownerDigest: input.source.ownerDigest,
      rho: "", blinding: "", spendSecret: "",
    });
    if (position.commitment.toLowerCase() === input.positionCommitments[fillIndex].toLowerCase()) return position;
  }
  throw new Error("Private smoke position witness does not match settled outputs");
}
