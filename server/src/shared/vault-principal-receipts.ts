import {createHash} from "node:crypto";
import type {Collection} from "mongodb";
import {remainingVaultMakerPrincipal,type VaultMakerAllocation} from "./vault-maker-backing";

interface AllocationReceiptDocument extends VaultMakerAllocation {
  _id:string;
  appliedPrincipalReceipts?:Record<string,{receiptId:string;principal:string;before:string}>;
}

export async function applyVaultPrincipalReceipt(
  allocations:Pick<Collection<AllocationReceiptDocument>,"findOne"|"updateOne">,
  input:{allocationDocumentId:string;receiptId:string;principal:bigint;before:bigint},
):Promise<void> {
  if(!input.receiptId||input.principal<=0n||input.before<input.principal)throw new Error("invalid vault principal receipt");
  const key=createHash("sha256").update(input.receiptId).digest("hex");
  const expected={receiptId:input.receiptId,principal:input.principal.toString(),before:input.before.toString()};
  const matches=(document:AllocationReceiptDocument|null):boolean=>{
    const applied=document?.appliedPrincipalReceipts?.[key];
    if(!applied)return false;
    if(applied.receiptId!==expected.receiptId||applied.principal!==expected.principal||applied.before!==expected.before) {
      throw new Error("conflicting applied vault principal receipt");
    }
    return true;
  };
  const current=await allocations.findOne({_id:input.allocationDocumentId});
  if(!current)throw new Error("maker allocation disappeared before principal reconciliation");
  if(matches(current))return;
  if(current.status!=="outstanding"||remainingVaultMakerPrincipal(current)!==input.before) {
    throw new Error("maker allocation principal changed before receipt reconciliation");
  }
  const result=await allocations.updateOne({
    _id:current._id,status:"outstanding",[`appliedPrincipalReceipts.${key}`]:{$exists:false},
    ...(current.remainingPrincipal===undefined?{remainingPrincipal:{$exists:false}}:{remainingPrincipal:current.remainingPrincipal}),
  },{$set:{remainingPrincipal:(input.before-input.principal).toString(),[`appliedPrincipalReceipts.${key}`]:expected}});
  if(result.modifiedCount!==1&&!matches(await allocations.findOne({_id:current._id}))) {
    throw new Error("maker allocation changed before receipt was atomically applied");
  }
}
