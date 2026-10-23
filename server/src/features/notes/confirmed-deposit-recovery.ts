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
export function depositRecoveryNetworkHash(passphrase:string):Hex{return hashFields("stellar-network-passphrase",[passphrase]);}
function hex(value:unknown,label:string):Hex {
  if(typeof value!=="string"||!/^(0x)?[0-9a-f]{64}$/i.test(value))throw new Error(`invalid ${label}`);
  return `0x${value.replace(/^0x/i,"").toLowerCase()}`;
}
export class StellarConfirmedDepositRecovery implements ConfirmedDepositRecoveryReader {
  constructor(private readonly env:ServerEnv,private readonly fetcher:typeof fetch=fetch,private readonly command:CommandReader=readStellarCommandAsync){}
  async read(pending:PendingAssetDepositRecord,cached:Hex[]) {
    const env=this.env,deployment=loadDeploymentRegistry(env.stellarDeploymentFile),pool=deployment?.contracts["shielded-pool"];
    if(!env.stellarOnchainRelay||env.stellarRelayerMode!=="stellar-cli"||!pool||deployment?.network!==env.stellarNetwork||PASSPHRASES[env.stellarNetwork]!==env.stellarNetworkPassphrase)throw new Error("confirmed deposit recovery network or pool is unavailable");
    const txHash=hex(pending.preparedTxHash,"prepared deposit transaction hash"),deadline=Date.now()+60_000;
    const timeout=()=>{const remaining=deadline-Date.now();if(remaining<=0)throw new Error("confirmed deposit recovery read deadline exceeded");return Math.min(remaining,20_000);};
    const rpc=async(method:string,params?:Record<string,unknown>)=>{
      const response=await this.fetcher(env.stellarRpcUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,...(params?{params}:{})}),signal:AbortSignal.timeout(timeout())});
      const result=await response.json() as {error?:unknown;result?:Record<string,unknown>};
      if(!response.ok||result.error||!result.result)throw new Error("confirmed deposit recovery RPC read failed");return result.result;
    };
    const network=await rpc("getNetwork");if(network.passphrase!==env.stellarNetworkPassphrase)throw new Error("confirmed deposit recovery RPC network mismatch");
    const transaction=await rpc("getTransaction",{hash:txHash.slice(2)});
    if(transaction.status!=="SUCCESS"||!Number.isSafeInteger(transaction.ledger)||Number(transaction.ledger)<=0)throw new Error("prepared deposit transaction is not confirmed");
    if(typeof transaction.envelopeXdr!=="string"||transaction.envelopeXdr.length>2_000_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(transaction.envelopeXdr))throw new Error("confirmed deposit transaction envelope is unavailable");
    const run=async(args:string[])=>{
      const result=await this.command(["stellar",...args],Math.min(timeout(),env.stellarCommandTimeoutMs));
      if(result.status!==0||typeof result.stdout!=="string")throw new Error("confirmed deposit recovery command failed");return result.stdout.trim();
    };
    const hashOutput=await run(["tx","hash",transaction.envelopeXdr,"--network-passphrase",env.stellarNetworkPassphrase]);
    let hashValue:unknown=hashOutput;
    if(hashOutput.startsWith('"')){try{hashValue=JSON.parse(hashOutput);}catch{throw new Error("invalid confirmed deposit envelope hash");}}
    const actualHash=hex(hashValue,"confirmed deposit envelope hash");
    if(actualHash!==txHash)throw new Error("confirmed deposit envelope does not match prepared transaction");
    const read=async(method:string,args:string[]=[])=>{
      const output=await run(["contract","invoke","--id",pool,"--source",env.stellarSource,"--network",env.stellarNetwork,"--rpc-url",env.stellarRpcUrl,"--network-passphrase",env.stellarNetworkPassphrase,"--send","no","--",method,...args]);
      try{return JSON.parse(output) as unknown;}catch{throw new Error("invalid confirmed deposit pool read");}
    };
    if(hex(await read("token_digest",["--token",pending.token]),"deposit token digest")!==pending.tokenDigest)throw new Error("pending deposit token digest mismatch");
    if(await read("has_commitment",["--commitment",pending.commitment.slice(2)])!==true)throw new Error("confirmed deposit commitment is not funded in the configured pool");
    const root=hex(await read("secure_note_root"),"secure note root");let commitments=[...cached];
    if(secureMarginRoot(commitments)!==root){
      const raw=await read("secure_note_count");
      if(!((typeof raw==="number"&&Number.isSafeInteger(raw))||(typeof raw==="string"&&/^\d+$/.test(raw))))throw new Error("invalid secure note count");
      const count=Number(raw);if(!Number.isSafeInteger(count)||count<0||count>(1<<20))throw new Error("invalid secure note count");
      const append=async(prefix:Hex[])=>{if(count-prefix.length>4096)throw new Error("secure note recovery exceeds read budget");const result=[...prefix];for(let index=result.length;index<count;index++)result.push(hex(await read("secure_note_leaf",["--index",String(index)]),"secure note leaf"));return result;};
      commitments=cached.length<=count?await append(cached):await append([]);
      if(secureMarginRoot(commitments)!==root)commitments=await append([]);
      if(secureMarginRoot(commitments)!==root)throw new Error("confirmed deposit secure note tree does not match its leaves");
    }
    if(hex(await read("secure_note_root"),"secure note root")!==root)throw new Error("secure note tree changed during deposit recovery; retry the confirmed read");
    if(!commitments.includes(pending.commitment))throw new Error("confirmed deposit is missing from the secure note tree");
    return {commitments,root,confirmation:{txHash,ledger:Number(transaction.ledger),network:env.stellarNetwork,networkPassphraseHash:depositRecoveryNetworkHash(env.stellarNetworkPassphrase),observedAt:Date.now()}};
  }
}
