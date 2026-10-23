import {expect,test} from "bun:test";
import {fieldHex,secureMarginCommitment} from "@pnlx/crypto";
import {makerCloseRecoveryAmount} from "../../scripts/operations/settle-vault-maker-position";

function note(amount:bigint) {
  const opening={amount,assetDigest:fieldHex(1n),ownerDigest:fieldHex(2n),rhoDigest:fieldHex(3n),
    blinding:fieldHex(4n),spendSecretDigest:fieldHex(5n)};
  return {...opening,amount:amount.toString(),commitment:secureMarginCommitment(opening),
    status:amount===0n?"draining":"spent",...(amount>0n?{recoveredAmount:amount.toString()}:{}),
    closePositionCommitment:fieldHex(6n),closeTxHash:`0x${"7".repeat(64)}`};
}
test("zero-value paired outputs recognize a total loss without a zero withdrawal",()=>{
  const zero=note(0n);
  expect(makerCloseRecoveryAmount(zero)).toBe(0n);
  expect(makerCloseRecoveryAmount({...zero,status:"spent",recoveredAmount:"0"})).toBe(0n);
  expect(()=>makerCloseRecoveryAmount({...zero,status:"pending"})).toThrow("not ready");
});
test("loss or recovered principal must match the actual secure output opening",()=>{
  const positive=note(10n);
  expect(makerCloseRecoveryAmount(positive)).toBe(10n);
  expect(()=>makerCloseRecoveryAmount({...positive,amount:"0",status:"draining"})).toThrow("commitment");
  expect(()=>makerCloseRecoveryAmount({...positive,recoveredAmount:"9"})).toThrow("fully recovered");
});
