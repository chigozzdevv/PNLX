import {expect,test} from "bun:test";
import {applyVaultPrincipalReceipt} from "@/shared/vault-principal-receipts";

function allocations() {
  const document:Record<string,any>={_id:"testnet:allocation",id:"allocation",amount:"100",
    remainingPrincipal:"100",status:"outstanding"};
  let writes=0;
  const collection={
    findOne:async()=>structuredClone(document),
    updateOne:async(filter:Record<string,any>,update:Record<string,any>)=>{
      const receiptPath=Object.keys(filter).find(key=>key.startsWith("appliedPrincipalReceipts."))!;
      const key=receiptPath.split(".")[1]!;
      if(document.remainingPrincipal!==filter.remainingPrincipal||document.status!==filter.status||document.appliedPrincipalReceipts?.[key]) {
        return {modifiedCount:0};
      }
      document.remainingPrincipal=update.$set.remainingPrincipal;
      (document.appliedPrincipalReceipts??={})[key]=update.$set[receiptPath];writes++;
      return {modifiedCount:1};
    },
  };
  return {document,collection:collection as never,writes:()=>writes};
}
test("only the exact applied receipt is idempotent after later principal movements",async()=>{
  const state=allocations();
  const first={allocationDocumentId:"testnet:allocation",receiptId:"position:first",before:100n,principal:20n};
  await applyVaultPrincipalReceipt(state.collection,first);
  expect(state.document.remainingPrincipal).toBe("80");
  await expect(applyVaultPrincipalReceipt(state.collection,{...first,receiptId:"position:distinct"})).rejects.toThrow("principal changed");
  expect(state.document.remainingPrincipal).toBe("80");
  await applyVaultPrincipalReceipt(state.collection,{...first,receiptId:"return:next",before:80n,principal:30n});
  expect(state.document.remainingPrincipal).toBe("50");
  await applyVaultPrincipalReceipt(state.collection,first);
  expect(state.document.remainingPrincipal).toBe("50");
  expect(state.writes()).toBe(2);
  await expect(applyVaultPrincipalReceipt(state.collection,{...first,principal:10n})).rejects.toThrow("conflicting");
});
test("concurrent distinct receipts sharing a before value cannot both consume it",async()=>{
  const state=allocations();
  const outcomes=await Promise.allSettled(["one","two"].map(receiptId=>applyVaultPrincipalReceipt(state.collection,{
    allocationDocumentId:"testnet:allocation",receiptId,before:100n,principal:20n})));
  expect(outcomes.filter(value=>value.status==="fulfilled")).toHaveLength(1);
  expect(outcomes.filter(value=>value.status==="rejected")).toHaveLength(1);
  expect(state.document.remainingPrincipal).toBe("80");
  expect(state.writes()).toBe(1);
});
