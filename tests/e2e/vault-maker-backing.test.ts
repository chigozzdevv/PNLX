import { describe, expect, test } from "bun:test";
import { assertSuccessfulTransaction, sameHex32 } from "../../scripts/operations/register-vault-maker-note";
import { notesForMakerRecovery } from "../../scripts/operations/withdraw-maker-notes";
import {
  allocationId,
  eligibleVaultMakerNotes,
  type VaultMakerAllocation,
} from "@/shared/vault-maker-backing";

const vault = "CAU2RWJFKWZIRWLTO734X2BSVIAH22WHCIRRYIBLQPHIUPPFQ6U5MMTQ";
const maker = "GCB7PYWNYIRTSLTHGPX6OCIP256PPX2Q5TZOZSNCVRIWZJI7MU5COC7J";
const asset = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const txHash = "a".repeat(64);
const id = allocationId(vault, txHash);
const root = {
  amount: "80000000",
  commitment: `0x${"1".repeat(64)}`,
  status: "available",
  token: asset,
  vaultAllocationId: id,
  walletAddress: maker,
};
const allocation: VaultMakerAllocation = {
  id,
  allocationLedger: 1,
  allocationTxHash: txHash,
  amount: "80000000",
  asset,
  maker,
  noteCommitments: [root.commitment],
  registeredAmount: "80000000",
  series: 0,
  status: "outstanding",
  vault,
};
const scope = { asset, deployedPrincipal: 80_000_000n, maker, seriesPrincipals: new Map([[0, 80_000_000n]]), vault };

describe("vault maker note eligibility", () => {
  test("does not match legacy notes merely because they are available in the maker wallet", () => {
    const legacy = { ...root, commitment: `0x${"2".repeat(64)}`, vaultAllocationId: undefined };
    expect(eligibleVaultMakerNotes([legacy, root], [allocation], scope)).toEqual([root]);
  });

  test("requires a matching outstanding allocation and current vault principal", () => {
    expect(eligibleVaultMakerNotes([root], [], scope)).toEqual([]);
    expect(eligibleVaultMakerNotes([root], [{ ...allocation, status: "closed" }], scope)).toEqual([]);
    expect(eligibleVaultMakerNotes([root], [allocation], { ...scope, deployedPrincipal: 0n })).toEqual([]);
    expect(eligibleVaultMakerNotes([root], [allocation], { ...scope, seriesPrincipals: new Map([[0, 0n]]) })).toEqual([]);
    expect(eligibleVaultMakerNotes([root], [allocation], { ...scope, asset: vault })).toEqual([]);
    expect(eligibleVaultMakerNotes([root], [{ ...allocation, noteCommitments: [] }], scope)).toEqual([]);
  });

  test("accepts change only after its registered parent is spent", () => {
    const change = {
      ...root,
      amount: "70000000",
      commitment: `0x${"3".repeat(64)}`,
      vaultParentCommitment: root.commitment,
    };
    expect(eligibleVaultMakerNotes([root, change], [allocation], scope)).toEqual([root]);
    const spentRoot = { ...root, status: "spent" };
    expect(eligibleVaultMakerNotes([spentRoot, change], [allocation], scope)).toEqual([change]);
    expect(eligibleVaultMakerNotes([spentRoot, { ...change, amount: "90000000" }], [allocation], scope)).toEqual([]);
  });

  test("fails closed if available notes exceed their allocation", () => {
    const second = { ...root, amount: "10000000", commitment: `0x${"4".repeat(64)}` };
    const sharedAllocation = { ...allocation, noteCommitments: [root.commitment, second.commitment] };
    expect(eligibleVaultMakerNotes([root, second], [sharedAllocation], scope)).toEqual([]);
  });

  test("does not borrow principal from another LP series", () => {
    const second = { ...allocation, id: `${vault}:${"b".repeat(64)}`, allocationTxHash: "b".repeat(64) };
    expect(eligibleVaultMakerNotes([root], [allocation, second],
      { ...scope, deployedPrincipal: 160_000_000n, seriesPrincipals: new Map([[0, 80_000_000n], [1, 80_000_000n]]) }))
      .toEqual([]);
  });
});

describe("vault backing transaction checks", () => {
  test("recovers only notes from the requested allocation", () => {
    const legacy = { ...root, commitment: `0x${"2".repeat(64)}`, vaultAllocationId: undefined };
    const other = { ...root, commitment: `0x${"3".repeat(64)}`, vaultAllocationId: "other:allocation" };
    const client = { ...root, commitment: `0x${"4".repeat(64)}`, walletAddress: "GOTHER" };
    expect(notesForMakerRecovery([legacy, other, client, root], maker, id)).toEqual([root]);
  });

  test("compares Stellar CLI digests with or without the 0x prefix", () => {
    expect(sameHex32('a'.repeat(64), `0x${'a'.repeat(64)}`)).toBe(true);
    expect(sameHex32('a'.repeat(64), `0x${'b'.repeat(64)}`)).toBe(false);
  });

  test("requires a confirmed transaction with the requested hash", async () => {
    const success = (async () => Response.json({ result: { ledger: 100, status: "SUCCESS", txHash } })) as unknown as typeof fetch;
    await expect(assertSuccessfulTransaction("https://rpc.example", txHash, success)).resolves.toBe(100);
    const failed = (async () => Response.json({ result: { ledger: 100, status: "FAILED", txHash } })) as unknown as typeof fetch;
    await expect(assertSuccessfulTransaction("https://rpc.example", txHash, failed)).rejects.toThrow();
    const other = (async () => Response.json({ result: { ledger: 100, status: "SUCCESS", txHash: "b".repeat(64) } })) as unknown as typeof fetch;
    await expect(assertSuccessfulTransaction("https://rpc.example", txHash, other)).rejects.toThrow();
  });
});
