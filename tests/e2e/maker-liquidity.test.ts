import { describe, expect, test } from "bun:test";
import {
  circuitMarginCommitment,
  hashFields,
} from "@pnlx/crypto";
import type { PrivateMatchIntent } from "@pnlx/protocol-types";
import {
  buildMakerChangeNote,
  selectMakerNoteAllocations,
} from "@/workers/maker-liquidity/maker-liquidity.service";

const note = {
  amount: "5000000000",
  assetDigest: hashFields("asset", ["usdc"]),
  blinding: hashFields("maker", ["blinding"]),
  commitment: hashFields("maker", ["note"]),
  noteNullifier: hashFields("maker", ["nullifier"]),
  ownerCommitment: hashFields("maker", ["owner"]),
  ownerDigest: hashFields("owner", ["maker"]),
  rhoDigest: hashFields("maker", ["rho"]),
  spendSecretDigest: hashFields("maker", ["spend"]),
  status: "available" as const,
  walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
};

const payload: PrivateMatchIntent = {
  batchId: "client-batch",
  intentCommitment: hashFields("intent", ["client"]),
  limitPrice: 19_775_000n,
  margin: 10_000_000n,
  marketId: "xlm-usd-perp",
  noteChangeCommitment: "0x0",
  noteNullifier: hashFields("client", ["nullifier"]),
  ownerCommitment: hashFields("client", ["owner"]),
  signedSize: 505_689_001n,
};

describe("maker note allocation", () => {
  test("uses only required margin from a larger maker note", () => {
    const [allocation] = selectMakerNoteAllocations([note], payload);
    expect(allocation.margin).toBe(payload.margin);
    expect(allocation.size).toBe(payload.signedSize);
    expect(allocation.note.commitment).toBe(note.commitment);
  });

  test("creates deterministic spendable change for the unused note amount", () => {
    const change = buildMakerChangeNote(
      note,
      payload.margin,
      payload.intentCommitment,
    );
    expect(change?.amount).toBe("4990000000");
    expect(change?.status).toBe("available");
    expect(change?.commitment).toBe(
      circuitMarginCommitment({
        amount: 4_990_000_000n,
        assetDigest: note.assetDigest,
        blinding: change!.blinding,
        ownerDigest: note.ownerDigest,
        rhoDigest: change!.rhoDigest,
        spendSecretDigest: change!.spendSecretDigest,
      }),
    );
    const repeated = buildMakerChangeNote(
      note,
      payload.margin,
      payload.intentCommitment,
    );
    expect(repeated?.commitment).toBe(change?.commitment);
    expect(repeated?.noteNullifier).toBe(change?.noteNullifier);

    const privateVariant = buildMakerChangeNote(
      { ...note, spendSecretDigest: hashFields("maker", ["another-private-spend"]) },
      payload.margin,
      payload.intentCommitment,
    );
    expect(privateVariant?.commitment).not.toBe(change?.commitment);
    expect(privateVariant?.noteNullifier).not.toBe(change?.noteNullifier);
  });

  test("combines smaller notes and returns change from the final note", () => {
    const requiredMargin = 6_000_000_000n;
    const allocations = selectMakerNoteAllocations(
      [
        makerNote("one", 2_500_000_000n),
        makerNote("two", 2_500_000_000n),
        makerNote("three", 2_500_000_000n),
      ],
      {
        ...payload,
        margin: requiredMargin,
        signedSize: 600_000_000n,
      },
    );

    expect(allocations.map((allocation) => allocation.margin)).toEqual([
      2_500_000_000n,
      2_500_000_000n,
      1_000_000_000n,
    ]);
    expect(allocations.reduce((sum, allocation) => sum + allocation.margin, 0n)).toBe(
      requiredMargin,
    );
    expect(allocations.reduce((sum, allocation) => sum + allocation.size, 0n)).toBe(
      600_000_000n,
    );
    expect(
      buildMakerChangeNote(
        allocations[2].note,
        allocations[2].margin,
        payload.intentCommitment,
      )?.amount,
    ).toBe("1500000000");
  });

  test("does not create change for an exact maker note", () => {
    expect(
      buildMakerChangeNote(
        { ...note, amount: payload.margin.toString() },
        payload.margin,
        payload.intentCommitment,
      ),
    ).toBeUndefined();
  });
});

function makerNote(label: string, amount: bigint) {
  return {
    ...note,
    amount: amount.toString(),
    blinding: hashFields("maker-blinding", [label]),
    commitment: hashFields("maker-note", [label]),
    noteNullifier: hashFields("maker-nullifier", [label]),
    rhoDigest: hashFields("maker-rho", [label]),
    spendSecretDigest: hashFields("maker-spend", [label]),
  };
}
