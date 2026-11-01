import {expect,test} from "bun:test";
import {fieldHex} from "@pnlx/crypto";
import {resolve} from "node:path";
import type {ServerEnv} from "@/config/env";
import {StellarConfirmedDepositRecovery} from "@/features/notes/confirmed-deposit-recovery";
import type {CommandResult} from "@/workers/relayer/relayer.model";
import {COUNT_STORAGE_KEY,ROOT_STORAGE_KEY,ledgerRow,ledgerRows,leafStorageKey,storageKeys} from "../../../../tests/helpers/secure-note-ledger";

function fixture(){
  const leaves=Array.from({length:160},(_,index)=>fieldHex(BigInt(index+1)));
  const pending={amount:100n,commitment:leaves.at(-1)!,from:"GCXW7ZMGSP4RK4LQHO2GMNT4DC4PKEFOQIL5U3ET6HREGJYPENQLQ7RH",
    token:"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",tokenDigest:fieldHex(501n),
    preparedTxHash:fieldHex(500n),preparedXdrDigest:fieldHex(502n),createdAt:1,depositProof:{} as never};
  const env={stellarOnchainRelay:true,stellarRelayerMode:"stellar-cli",stellarDeploymentFile:resolve(import.meta.dir,"../../../../deployments/testnet.json"),
    stellarNetwork:"testnet",stellarNetworkPassphrase:"Test SDF Network ; September 2015",stellarRpcUrl:"https://rpc.invalid",stellarCommandTimeoutMs:10_000,stellarSource:"pnlx-testnet"} as ServerEnv;
  const state={leaves:[...leaves],rateLimits:0,rpcRateLimits:0,permanentFailure:false,corrupt:"" as ""|"missing"|"duplicate"|"unexpected"|"value",
    appendAfterBatch:false,alwaysAppend:false,count:undefined as number|undefined,leafAttempts:0,tailReads:0};
  const commands:string[][]=[],rpcMethods:string[]=[],timeouts:number[]=[];
  const fetcher=(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    const {method}=JSON.parse(String(init?.body));rpcMethods.push(method);
    if(state.rpcRateLimits-->0)return Response.json({error:{code:429}},{status:429});
    return Response.json({result:method==="getNetwork"?{passphrase:env.stellarNetworkPassphrase}:{status:"SUCCESS",ledger:7,envelopeXdr:"YWJj"}});
  }) as unknown as typeof fetch;
  const command=async(args:string[],timeout:number):Promise<CommandResult>=>{
    commands.push(args);timeouts.push(timeout);
    if(args[1]==="tx"&&args[2]==="hash")return {status:0,stdout:pending.preparedTxHash,stderr:""};
    if(args[2]==="invoke"){
      const method=args[args.indexOf("--")+1];
      if(method!=="token_digest"&&method!=="has_commitment")throw new Error("per-leaf simulation must not run");
      return {status:0,stdout:JSON.stringify(method==="token_digest"?pending.tokenDigest:true),stderr:""};
    }
    if(args[2]!=="read")throw new Error("unexpected command");
    const keys=storageKeys(args),isLeafBatch=!keys.includes(ROOT_STORAGE_KEY)&&!keys.includes(COUNT_STORAGE_KEY);
    if(isLeafBatch){
      state.leafAttempts++;
      if(state.rateLimits-->0)return {status:1,stdout:"",stderr:"error: Request rejected `429`"};
      if(state.permanentFailure)return {status:1,stdout:"",stderr:"error: invalid XDR"};
    }
    if(keys.length===1&&keys[0]===ROOT_STORAGE_KEY){state.tailReads++;if(state.alwaysAppend)state.leaves.push(fieldHex(BigInt(10_000+state.tailReads)));}
    let stdout=ledgerRows(args,state.leaves);
    if(state.count!==undefined&&keys.includes(COUNT_STORAGE_KEY))stdout=stdout.replace(ledgerRow(COUNT_STORAGE_KEY,state.leaves.length),ledgerRow(COUNT_STORAGE_KEY,state.count));
    if(isLeafBatch&&state.corrupt){
      const rows=stdout.trim().split("\n");
      if(state.corrupt==="missing")rows.shift();
      if(state.corrupt==="duplicate")rows.push(rows[0]!);
      if(state.corrupt==="unexpected")rows[0]=rows[0]!.replace(rows[0]!.split(",")[0]!,leafStorageKey(9999));
      if(state.corrupt==="value"){const cells=rows[0]!.split(",");cells[1]="AAAA";rows[0]=cells.join(",");}
      stdout=rows.join("\n");
    }
    if(isLeafBatch&&state.appendAfterBatch){state.leaves.push(fieldHex(999n));state.appendAfterBatch=false;}
    return {status:0,stdout,stderr:""};
  };
  return {leaves,pending,state,commands,rpcMethods,timeouts,reader:new StellarConfirmedDepositRecovery(env,fetcher,command)};
}

test("full note trees use bounded ledger batches and retain leaf order even when rows are reversed",async()=>{
  const f=fixture(),result=await f.reader.read(f.pending,[]);
  expect(result.commitments).toEqual(f.leaves);
  const batches=f.commands.filter(args=>args[2]==="read").map(storageKeys);
  expect(batches.map(keys=>keys.length)).toEqual([2,64,64,32,1]);
  expect(batches.flat()).toContain("AAAAEAAAAAEAAAACAAAADwAAAA5TZWN1cmVUcmVlTGVhZgAAAAAAAwAAAGg=");
  expect(f.timeouts.every(timeout=>timeout>0&&timeout<=10_000)).toBe(true);
});

test("a matching cached tree needs only header and final-root reads",async()=>{
  const f=fixture();
  expect((await f.reader.read(f.pending,f.leaves)).commitments).toEqual(f.leaves);
  expect(f.state.leafAttempts).toBe(0);
  expect(f.commands.filter(args=>args[2]==="read")).toHaveLength(2);
});

test("a bad cached prefix is rebuilt without trusting its leaf positions",async()=>{
  const f=fixture(),cached=f.leaves.slice(0,150);cached[0]=fieldHex(900n);
  expect((await f.reader.read(f.pending,cached)).commitments).toEqual(f.leaves);
  expect(f.state.leafAttempts).toBe(4);
});

test("a rate-limited ledger read retries the same read without invoking or submitting a transaction",async()=>{
  const f=fixture();f.state.rateLimits=1;
  expect((await f.reader.read(f.pending,[])).commitments).toEqual(f.leaves);
  const attempts=f.commands.filter(args=>args[2]==="read"&&storageKeys(args)[0]===leafStorageKey(0));
  expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);
  expect(f.commands.every(args=>args[1]==="tx"&&args[2]==="hash"||args[1]==="contract"&&args[2]==="read"||args.includes("--send")&&args[args.indexOf("--send")+1]==="no")).toBe(true);
});

test("RPC rate limits are retried before checking transaction confirmation",async()=>{
  const f=fixture();f.state.rpcRateLimits=1;
  await f.reader.read(f.pending,f.leaves);
  expect(f.rpcMethods).toEqual(["getNetwork","getNetwork","getTransaction"]);
});

test("persistent rate limits stop after three attempts",async()=>{
  const f=fixture();f.state.rateLimits=100;
  await expect(f.reader.read(f.pending,[])).rejects.toThrow("command failed");
  expect(f.state.leafAttempts).toBe(3);
});

test("permanent command failures are not retried",async()=>{
  const f=fixture();f.state.permanentFailure=true;
  await expect(f.reader.read(f.pending,[])).rejects.toThrow("command failed");
  expect(f.state.leafAttempts).toBe(1);
});

for(const corrupt of ["missing","duplicate","unexpected","value"] as const)test(`${corrupt} storage rows cannot become confirmed membership`,async()=>{
  const f=fixture();f.state.corrupt=corrupt;
  await expect(f.reader.read(f.pending,[])).rejects.toThrow();
  expect(f.state.leafAttempts).toBe(1);
});

test("a tree append during recovery is refreshed before returning a receipt",async()=>{
  const f=fixture();f.state.appendAfterBatch=true;
  expect((await f.reader.read(f.pending,[])).commitments).toEqual(f.state.leaves);
  expect(f.state.tailReads).toBe(2);
});

test("a continuously changing tree never returns an unverified receipt",async()=>{
  const f=fixture();f.state.alwaysAppend=true;
  await expect(f.reader.read(f.pending,[])).rejects.toThrow("tree changed");
  expect(f.state.tailReads).toBe(3);
});

test("oversized recovery requests fail before allocating or reading leaf batches",async()=>{
  const f=fixture();f.state.count=4097;
  await expect(f.reader.read(f.pending,[])).rejects.toThrow("read budget");
  expect(f.state.leafAttempts).toBe(0);
});
