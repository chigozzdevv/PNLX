import {secureMarginRoot} from "@pnlx/crypto";
import type {Hex} from "@pnlx/protocol-types";

export const ROOT_STORAGE_KEY="AAAAEAAAAAEAAAABAAAADwAAAA5TZWN1cmVUcmVlUm9vdAAA";
export const COUNT_STORAGE_KEY="AAAAEAAAAAEAAAABAAAADwAAAA9TZWN1cmVUcmVlQ291bnQA";
const LEAF_ZERO=Buffer.from("AAAAEAAAAAEAAAACAAAADwAAAA5TZWN1cmVUcmVlTGVhZgAAAAAAAwAAAAA=","base64");

export function leafStorageKey(index:number):string {
  const key=Buffer.from(LEAF_ZERO);
  key.writeUInt32BE(index,key.length-4);
  return key.toString("base64");
}

export function storageKeys(args:string[]):string[] {
  return args.flatMap((arg,index)=>arg==="--key-xdr"?[args[index+1]!]:[]);
}

export function ledgerRow(key:string,value:Hex|number):string {
  const bytes=typeof value==="number"?Buffer.alloc(8):Buffer.alloc(40);
  bytes.writeUInt32BE(typeof value==="number"?3:13,0);
  if(typeof value==="number")bytes.writeUInt32BE(value,4);
  else {bytes.writeUInt32BE(32,4);Buffer.from(value.slice(2),"hex").copy(bytes,8);}
  return [key,bytes.toString("base64"),"AAAAAQ==","AAAAAA=="].join(",");
}

export function ledgerRows(args:string[],leaves:Hex[],root=secureMarginRoot(leaves)):string {
  return storageKeys(args).reverse().flatMap(key=>{
    if(key===ROOT_STORAGE_KEY)return [ledgerRow(key,root)];
    if(key===COUNT_STORAGE_KEY)return [ledgerRow(key,leaves.length)];
    const bytes=Buffer.from(key,"base64");
    if(bytes.length!==LEAF_ZERO.length||!bytes.subarray(0,-4).equals(LEAF_ZERO.subarray(0,-4)))throw new Error("unexpected storage key");
    const index=bytes.readUInt32BE(bytes.length-4);
    return leaves[index]===undefined?[]:[ledgerRow(key,leaves[index]!)];
  }).join("\n")+"\n";
}
