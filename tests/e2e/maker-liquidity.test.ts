import { describe, expect, test } from "bun:test";
import {
  secureMarginCommitment,
  hashFields,
} from "@pnlx/crypto";
import type { PrivateMatchIntent } from "@pnlx/protocol-types";
import {
  buildMakerChangeNote,
  eligibleMakerNotes,
  MakerLiquidityService,
  makerQuoteForIntent,
  finalizedMakerNotes,
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
  token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
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
  ownerDigest: hashFields("fixture-owner-digest", ["client"]),
  positionSeed: hashFields("fixture-position-seed", ["client"]),
  signedSize: 505_689_001n,
};

describe("maker note allocation", () => {
  test("uses only notes from the configured maker account", () => {
    const anotherWallet = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
    const otherNote = { ...note, walletAddress: anotherWallet };
    expect(eligibleMakerNotes([note, otherNote], note.walletAddress)).toEqual([note]);
    expect(eligibleMakerNotes([note, otherNote])).toHaveLength(2);
  });

  test("does not use the vault maker account outside XLM/USD", async () => {
    const service = new MakerLiquidityService(
      undefined as never,
      undefined as never,
      undefined,
      { intentRegistryOnchainRequired: true, makerWalletAddress: note.walletAddress },
    );
    expect(await service.ensureForMarket({ batchId: "other-market", marketId: "btc-usd-perp" }))
      .toEqual({ created: 0, skipped: 0 });
  });

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
      secureMarginCommitment({
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

    const vaultedChange = buildMakerChangeNote(
      { ...note, vaultAllocationId: "vault:allocation" },
      payload.margin,
      payload.intentCommitment,
    );
    expect(vaultedChange?.vaultAllocationId).toBe("vault:allocation");
    expect(vaultedChange?.vaultParentCommitment).toBe(note.commitment);
    expect(vaultedChange?.token).toBe(note.token);

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

describe("house maker price policy", () => {
  test("quotes both sides from the reference rather than copying a client limit", () => {
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 101n }, 100n)).toBe(100n);
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 99n }, 100n)).toBe(100n);
  });

  test("rejects a non-crossing limit and an extreme limit on either side", () => {
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 99n }, 100n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 101n }, 100n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 1_000_000n }, 100n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 1n }, 100n)).toBeUndefined();
  });

  test("applies spread against the customer and uses conservative integer rounding", () => {
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 102n }, 101n, 25n)).toBe(102n);
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 100n }, 101n, 25n)).toBe(100n);
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 101n }, 101n, 25n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 101n }, 101n, 25n)).toBeUndefined();
  });

  test("enforces the exact two-percent client-price boundary", () => {
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 10_200n }, 10_000n)).toBe(10_000n);
    expect(makerQuoteForIntent({ signedSize: 1n, limitPrice: 10_201n }, 10_000n)).toBeUndefined();
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 9_800n }, 10_000n)).toBe(10_000n);
    expect(makerQuoteForIntent({ signedSize: -1n, limitPrice: 9_799n }, 10_000n)).toBeUndefined();
  });

  test("rejects invalid reference/spread policies before quoting", () => {
    expect(() => makerQuoteForIntent({ signedSize: 1n, limitPrice: 100n }, 0n)).toThrow("invalid maker price policy");
    expect(() => makerQuoteForIntent({ signedSize: 1n, limitPrice: 100n }, 100n, -1n)).toThrow("invalid maker price policy");
    expect(() => makerQuoteForIntent({ signedSize: 1n, limitPrice: 100n }, 100n, 10_000n)).toThrow("invalid maker price policy");
  });
});

test("settlement replay preserves an existing child note in either store order", () => {
  const makerIntent = hashFields("maker-replay", ["intent"]);
  const sourceIntent = payload.intentCommitment;
  const parent = { ...note, status: "spent" as const,
    lockedByIntentCommitment: makerIntent, sourceIntentCommitment: sourceIntent };
  const change = buildMakerChangeNote(parent, payload.margin, sourceIntent)!;
  for (const status of ["spent", "locked", "draining", "withdrawing"] as const) {
    const child = { ...change, status };
    for (const notes of [[parent, child], [child, parent]]) {
      const result = finalizedMakerNotes(notes, new Set([makerIntent]), new Map([[makerIntent, payload]]));
      expect(result.filter((item) => item.commitment === child.commitment)).toEqual([child]);
      expect(result.find((item) => item.commitment === child.commitment)?.status).toBe(status);
    }
  }
});
