import {hashFields,secureMarginRoot} from "@pnlx/crypto";
import type {ConfirmedAssetDepositRecovery,Hex,PendingAssetDepositRecord} from "@pnlx/protocol-types";
import type {ServerEnv} from "@/config/env";
import {loadDeploymentRegistry} from "@/workers/onchain/deployment";
import {readStellarCommandAsync} from "@/workers/relayer/relayer.service";

type CommandReader=typeof readStellarCommandAsync;
export interface ConfirmedDepositRecoveryReader {
  read(pending:PendingAssetDepositRecord,cached:Hex[]):Promise<{
    confirmation:ConfirmedAssetDepositRecovery;commitments:Hex[];root:Hex;
  }>;
}
const PASSPHRASES:Record<string,string>={testnet:"Test SDF Network ; September 2015",mainnet:"Public Global Stellar Network ; September 2015"};
const LEAF_READ_BATCH_SIZE=64;
const SCV_U32=3,SCV_BYTES=13,SCV_SYMBOL=15,SCV_VEC=16;
class TransientDepositReadError extends Error {}
export function depositRecoveryNetworkHash(passphrase:string):Hex{return hashFields("stellar-network-passphrase",[passphrase]);}
function hex(value:unknown,label:string):Hex {
  if(typeof value!=="string"||!/^(0x)?[0-9a-f]{64}$/i.test(value))throw new Error(`invalid ${label}`);
  return `0x${value.replace(/^0x/i,"").toLowerCase()}`;
}
function storageKey(name:"SecureTreeRoot"|"SecureTreeCount"|"SecureTreeLeaf",index?:number):string {
  const symbol=Buffer.from(name),padded=Math.ceil(symbol.length/4)*4;
  const key=Buffer.alloc(20+padded+(index===undefined?0:8));
  [SCV_VEC,1,index===undefined?1:2,SCV_SYMBOL,symbol.length].forEach((word,offset)=>key.writeUInt32BE(word,offset*4));
  symbol.copy(key,20);
  if(index!==undefined){key.writeUInt32BE(SCV_U32,key.length-8);key.writeUInt32BE(index,key.length-4);}
  return key.toString("base64");
}
function storageValues(output:string,keys:string[]):unknown[] {
  const expected=new Set(keys),values=new Map<string,unknown>();
  for(const row of output.split(/\r?\n/).filter(Boolean)){
    const cells=row.split(","),key=cells[0]!,encoded=cells[1];
    if(cells.length!==4||!expected.has(key)||values.has(key)||!encoded)throw new Error("invalid confirmed deposit storage read");
    const value=Buffer.from(encoded,"base64");
    if(value.toString("base64")!==encoded||value.length<8)throw new Error("invalid confirmed deposit storage value");
    if(value.readUInt32BE(0)===SCV_U32&&value.length===8)values.set(key,value.readUInt32BE(4));
    else if(value.readUInt32BE(0)===SCV_BYTES&&value.length===40&&value.readUInt32BE(4)===32)values.set(key,`0x${value.subarray(8).toString("hex")}`);
    else throw new Error("invalid confirmed deposit storage value");
  }
  if(values.size!==keys.length)throw new Error("confirmed deposit storage read is incomplete");
  return keys.map(key=>values.get(key));
}
function transientReadFailure(output:string):boolean {
  return /\b(?:429|502|503|504)\b|rate.?limit|too many requests|request rejected|try_again_later|timed?\s*out|timeout|connection reset|econnreset|unable to connect/i.test(output);
}
export class StellarConfirmedDepositRecovery implements ConfirmedDepositRecoveryReader {
  constructor(private readonly env:ServerEnv,private readonly fetcher:typeof fetch=fetch,private readonly command:CommandReader=readStellarCommandAsync){}
  async read(pending:PendingAssetDepositRecord,cached:Hex[]) {
    const env=this.env,deployment=loadDeploymentRegistry(env.stellarDeploymentFile),pool=deployment?.contracts["shielded-pool"];
    if(!env.stellarOnchainRelay||env.stellarRelayerMode!=="stellar-cli"||!pool||deployment?.network!==env.stellarNetwork||PASSPHRASES[env.stellarNetwork]!==env.stellarNetworkPassphrase)throw new Error("confirmed deposit recovery network or pool is unavailable");
    const txHash=hex(pending.preparedTxHash,"prepared deposit transaction hash"),deadline=Date.now()+90_000;
    const timeout=()=>{const remaining=deadline-Date.now();if(remaining<=0)throw new Error("confirmed deposit recovery read deadline exceeded");return Math.min(remaining,20_000);};
    const retry=async<T>(read:()=>Promise<T>):Promise<T>=>{
      for(let attempt=0;;attempt++){
        try{return await read();}catch(error){
          if(!(error instanceof TransientDepositReadError)||attempt>=2)throw error;
          await new Promise<void>(resolve=>setTimeout(resolve,Math.min(750*(attempt+1),timeout())));
        }
      }
    };
    const rpc=async(method:string,params?:Record<string,unknown>)=>retry(async()=>{
      let response:Response;
      try{response=await this.fetcher(env.stellarRpcUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,...(params?{params}:{})}),signal:AbortSignal.timeout(timeout())});}
      catch{timeout();throw new TransientDepositReadError("confirmed deposit recovery RPC read failed");}
      if(response.status===429||response.status>=500){await response.body?.cancel();throw new TransientDepositReadError("confirmed deposit recovery RPC read failed");}
      const result=await response.json() as {error?:unknown;result?:Record<string,unknown>};
      if(result.error&&transientReadFailure(JSON.stringify(result.error)))throw new TransientDepositReadError("confirmed deposit recovery RPC read failed");
      if(!response.ok||result.error||!result.result)throw new Error("confirmed deposit recovery RPC read failed");return result.result;
    });
    const network=await rpc("getNetwork");if(network.passphrase!==env.stellarNetworkPassphrase)throw new Error("confirmed deposit recovery RPC network mismatch");
    const transaction=await rpc("getTransaction",{hash:txHash.slice(2)});
    if(transaction.status!=="SUCCESS"||!Number.isSafeInteger(transaction.ledger)||Number(transaction.ledger)<=0)throw new Error("prepared deposit transaction is not confirmed");
    if(typeof transaction.envelopeXdr!=="string"||transaction.envelopeXdr.length>2_000_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(transaction.envelopeXdr))throw new Error("confirmed deposit transaction envelope is unavailable");
    const run=async(args:string[])=>retry(async()=>{
      const result=await this.command(["stellar",...args],Math.min(timeout(),env.stellarCommandTimeoutMs));
      if(result.status!==0&&transientReadFailure(`${result.stderr}\n${result.stdout}`))throw new TransientDepositReadError("confirmed deposit recovery command failed");
      if(result.status!==0||typeof result.stdout!=="string")throw new Error("confirmed deposit recovery command failed");return result.stdout.trim();
    });
    const hashOutput=await run(["tx","hash",transaction.envelopeXdr,"--network-passphrase",env.stellarNetworkPassphrase]);
    let hashValue:unknown=hashOutput;
    if(hashOutput.startsWith('"')){try{hashValue=JSON.parse(hashOutput);}catch{throw new Error("invalid confirmed deposit envelope hash");}}
    const actualHash=hex(hashValue,"confirmed deposit envelope hash");
    if(actualHash!==txHash)throw new Error("confirmed deposit envelope does not match prepared transaction");
    const read=async(method:string,args:string[]=[])=>{
      const output=await run(["contract","invoke","--id",pool,"--source",env.stellarSource,"--network",env.stellarNetwork,"--rpc-url",env.stellarRpcUrl,"--network-passphrase",env.stellarNetworkPassphrase,"--send","no","--",method,...args]);
      try{return JSON.parse(output) as unknown;}catch{throw new Error("invalid confirmed deposit pool read");}
    };
    const readStorage=async(keys:string[])=>storageValues(await run(["contract","read","--id",pool,"--network",env.stellarNetwork,"--rpc-url",env.stellarRpcUrl,"--network-passphrase",env.stellarNetworkPassphrase,"--durability","persistent","--output","xdr",...keys.flatMap(key=>["--key-xdr",key])]),keys);
    if(hex(await read("token_digest",["--token",pending.token]),"deposit token digest")!==pending.tokenDigest)throw new Error("pending deposit token digest mismatch");
    if(await read("has_commitment",["--commitment",pending.commitment.slice(2)])!==true)throw new Error("confirmed deposit commitment is not funded in the configured pool");
    const rootKey=storageKey("SecureTreeRoot"),countKey=storageKey("SecureTreeCount");
    let commitments=[...cached];
    for(let attempt=0;attempt<3;attempt++){
      const header=await readStorage([rootKey,countKey]),root=hex(header[0],"secure note root"),count=header[1];
      if(typeof count!=="number"||!Number.isSafeInteger(count)||count<0||count>(1<<20))throw new Error("invalid secure note count");
      if(secureMarginRoot(commitments)!==root){
        const append=async(prefix:Hex[])=>{
          if(count-prefix.length>4096)throw new Error("secure note recovery exceeds read budget");
          const result=[...prefix];
          for(let offset=result.length;offset<count;offset+=LEAF_READ_BATCH_SIZE){
            const keys=Array.from({length:Math.min(LEAF_READ_BATCH_SIZE,count-offset)},(_,index)=>storageKey("SecureTreeLeaf",offset+index));
            result.push(...(await readStorage(keys)).map(leaf=>hex(leaf,"secure note leaf")));
          }
          return result;
        };
        commitments=commitments.length<=count?await append(commitments):await append([]);
        if(secureMarginRoot(commitments)!==root)commitments=await append([]);
        if(secureMarginRoot(commitments)!==root)throw new Error("confirmed deposit secure note tree does not match its leaves");
      }
      if(hex((await readStorage([rootKey]))[0],"secure note root")!==root)continue;
      if(!commitments.includes(pending.commitment))throw new Error("confirmed deposit is missing from the secure note tree");
      return {commitments,root,confirmation:{txHash,ledger:Number(transaction.ledger),network:env.stellarNetwork,networkPassphraseHash:depositRecoveryNetworkHash(env.stellarNetworkPassphrase),observedAt:Date.now()}};
    }
    throw new Error("secure note tree changed during deposit recovery; retry the confirmed read");
  }
}
