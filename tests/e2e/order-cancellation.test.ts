import {afterEach,describe,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {digestToFieldHex,ownerCommitment} from "@pnlx/crypto";
import type {Hex} from "@pnlx/protocol-types";
import {OrdersService} from "@/features/orders/orders.service";
import {OrdersController} from "@/features/orders/orders.controller";
import {Router} from "@/shared/http/router";
import {setAuthenticatedAddress} from "@/shared/http/auth-context";
import {FileProtocolStore} from "@/shared/state/persistent-store";
import {ProtocolStore} from "@/shared/state/store";
import {withPositionMutation} from "@/shared/protocol/position-mutation";
import {ExecutorService} from "@/workers/executor/executor.service";
import {OnchainRelayService} from "@/workers/onchain/onchain.service";

const key=(label:string)=>digestToFieldHex(`order-cancellation:${label}`);
const owner="GOWNER",intentCommitment=key("intent"),noteNullifier=key("source-note-nullifier");
const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{force:true,recursive:true});});
function source(store=new ProtocolStore()) {
  store.addResidualOrder({batchId:"batch",marketId:"xlm-usd-perp",createdAt:1,updatedAt:1,
    intentCommitment,noteNullifier,ownerCommitment:ownerCommitment(owner),
    matchingPayloadCommitment:key("payload"),sourceIntentCommitment:key("original-intent")});
  return store;
}
function chain(){const state={active:true,cancelled:false,spent:false,submissions:0};return {state,onchain:{enabled:true,
  isIntentActiveAsync:async()=>state.active,isIntentCancelledAsync:async()=>state.cancelled,
  isSecureNullifierSpentAsync:async()=>state.spent,
  cancelIntent(){throw new Error("synchronous cancellation must never run");},
  async cancelIntentAsync(){state.submissions++;state.active=false;state.cancelled=true;
    return {relays:[{functionName:"cancel",submitted:true,txHash:key("cancellation-tx")}]};}}};}
function service(store:ProtocolStore,onchain:unknown){return new OrdersService(new ExecutorService({},store),{} as never,onchain as never,{intentRegistryOnchainRequired:true});}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

describe("authoritative order cancellation",()=>{
  test("a submitted cancellation acknowledgement cannot release a still-active order",async()=>{
    const store=source(),mock=chain();mock.onchain.cancelIntentAsync=async()=>{mock.state.submissions++;return {relays:[{functionName:"cancel",submitted:true,txHash:key("false-ack")}]};};
    await expect(service(store,mock.onchain).cancelDurable({intentCommitment},owner)).rejects.toThrow("unconfirmed");
    expect(store.orderLifecycle.get(intentCommitment)?.status).toBe("open");
    expect(store.spentNullifiers.has(noteNullifier)).toBe(false);
    expect(mock.state.submissions).toBe(1);
  });

  test("an inactive flag alone does not certify cancellation",async()=>{
    const store=source(),mock=chain();mock.onchain.cancelIntentAsync=async()=>{mock.state.active=false;return {relays:[{functionName:"cancel",submitted:true,txHash:key("missing-cancel-flag")}]};};
    await expect(service(store,mock.onchain).cancelDurable({intentCommitment},owner)).rejects.toThrow("unconfirmed");
    expect(store.orderLifecycle.get(intentCommitment)?.status).toBe("open");
  });

  test("a lost relay response reconciles confirmed cancellation durably and retries without another submission",async()=>{
    const directory=mkdtempSync(join(tmpdir(),"pnlx-order-cancel-"));directories.push(directory);const path=join(directory,"state.json"),store=source(new FileProtocolStore(path)),mock=chain();
    mock.onchain.cancelIntentAsync=async()=>{mock.state.submissions++;mock.state.active=false;mock.state.cancelled=true;throw new Error("response was lost");};
    expect((await service(store,mock.onchain).cancelDurable({intentCommitment},owner)).order.status).toBe("cancelled");
    const restarted=new FileProtocolStore(path);
    expect(restarted.orderLifecycle.get(intentCommitment)?.status).toBe("cancelled");
    expect(restarted.orderLifecycle.get(intentCommitment)?.cancellationTxHash).toBeUndefined();
    expect((await service(restarted,mock.onchain).cancelDurable({intentCommitment},owner)).order.status).toBe("cancelled");
    expect(mock.state.submissions).toBe(1);
  });

  test("spent collateral before cancellation or a concurrent fill never becomes locally cancelled",async()=>{
    for(const concurrent of [false,true]){
      const store=source(),mock=chain();mock.state.spent=!concurrent;
      mock.onchain.cancelIntentAsync=async()=>{mock.state.submissions++;mock.state.active=false;mock.state.cancelled=true;mock.state.spent=true;return {relays:[{functionName:"cancel",submitted:true,txHash:key("fill-won")}]};};
      await expect(service(store,mock.onchain).cancelDurable({intentCommitment},owner)).rejects.toThrow("spent");
      expect(store.orderLifecycle.get(intentCommitment)?.status).toBe("open");
      expect(mock.state.submissions).toBe(concurrent?1:0);
    }
  });

  test("cancellation waits for the batch mutation lane and observes a fill before sending",async()=>{
    const store=source(),mock=chain(),entered=deferred(),release=deferred();
    const filling=withPositionMutation(store,async()=>{entered.resolve();await release.promise;store.spend(noteNullifier);const order=store.orderLifecycle.get(intentCommitment)!;store.orderLifecycle.set(intentCommitment,{...order,status:"filled"});});
    await entered.promise;const cancelling=service(store,mock.onchain).cancelDurable({intentCommitment},owner);
    await Bun.sleep(1);expect(mock.state.submissions).toBe(0);release.resolve();await filling;
    await expect(cancelling).rejects.toThrow("filled order");expect(mock.state.submissions).toBe(0);
    expect(store.orderLifecycle.get(intentCommitment)?.status).toBe("filled");
  });

  test("concurrent cancellation requests share one financial submission",async()=>{
    const store=source(),mock=chain(),orders=service(store,mock.onchain);
    const results=await Promise.all([orders.cancelDurable({intentCommitment},owner),orders.cancelDurable({intentCommitment},owner)]);
    expect(results.map(result=>result.order.status)).toEqual(["cancelled","cancelled"]);expect(mock.state.submissions).toBe(1);
  });

  test("local cancellation retries remain idempotent while required on-chain mode still fails closed",async()=>{
    const store=source(),executor=new ExecutorService({},store);
    const orders=new OrdersService(executor,{} as never);
    expect((await orders.cancelDurable({intentCommitment},owner)).order.status).toBe("cancelled");
    expect((await orders.cancelDurable({intentCommitment},owner)).order.status).toBe("cancelled");
    await expect(service(store,undefined).cancelDurable({intentCommitment},owner)).rejects.toThrow("requires on-chain relay");
  });

  test("missing async capabilities fail closed before any synchronous relay",async()=>{
    const store=source(),mock=chain();const orders=service(store,{...mock.onchain,cancelIntentAsync:undefined});
    await expect(orders.cancelDurable({intentCommitment},owner)).rejects.toThrow("async cancellation recovery readers");
    expect(()=>orders.cancel({intentCommitment},owner)).toThrow("durable async path");expect(mock.state.submissions).toBe(0);
    expect(store.orderLifecycle.get(intentCommitment)?.status).toBe("open");
  });

  test("the async HTTP controller awaits confirmation while health requests and timers remain responsive",async()=>{
    const store=source(),mock=chain(),entered=deferred(),release=deferred();
    mock.onchain.cancelIntentAsync=async()=>{mock.state.submissions++;entered.resolve();await release.promise;mock.state.cancelled=true;mock.state.active=false;return {relays:[{functionName:"cancel",submitted:true,txHash:key("async-tx")}]};};
    const controller=new OrdersController(service(store,mock.onchain));
    const router=new Router();
    router.add("GET","/health",()=>Response.json({ok:true}));
    router.add("POST","/orders/cancel",request=>{setAuthenticatedAddress(request,owner);return controller.cancel(request);});
    const cancellation=router.handle(new Request("http://localhost/orders/cancel",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({intentCommitment})}));
    try{await entered.promise;let ticked=false;await new Promise<void>(done=>setTimeout(()=>{ticked=true;done();},1));
      expect((await router.handle(new Request("http://localhost/health"))).ok).toBe(true);expect(ticked).toBe(true);expect(store.orderLifecycle.get(intentCommitment)?.status).toBe("open");
      release.resolve();const response=await cancellation;expect(response.ok).toBe(true);expect(await response.json()).toMatchObject({order:{status:"cancelled"}});
    }finally{release.resolve();await cancellation;}

  });
});

describe("strict asynchronous registry cancellation reads",()=>{
  const contract="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  function reader(stdout:string|undefined){return new OnchainRelayService({read(){throw new Error("sync read must not run");},readAsync:async()=>({stdout,output:"false"})} as never,{enabled:true,deployment:{contracts:{"intent-registry":contract,"shielded-pool":contract}}} as never);}
  test("malformed or missing stdout never certifies cancellation, inactivity or unspent collateral",async()=>{
    for(const value of [undefined,"",'"true"',"{\"cancelled\":true}","diagnostic true", "null"]){const relay=reader(value);
      await expect(relay.isIntentCancelledAsync(intentCommitment)).rejects.toThrow();
      await expect(relay.isIntentActiveAsync(intentCommitment)).rejects.toThrow();
      await expect(relay.isSecureNullifierSpentAsync(noteNullifier)).rejects.toThrow();}
    for(const value of [true,false])expect(await reader(JSON.stringify(value)).isIntentCancelledAsync(intentCommitment)).toBe(value);
  });
  test("cancelIntentAsync uses the existing async relayer and source lane",async()=>{
    const requests:unknown[]=[];const relay=new OnchainRelayService({relay(){throw new Error("sync relay must not run");},relayAsync:async(request:unknown)=>{requests.push(request);return {submitted:true,functionName:"cancel",txHash:key("relay")};}} as never,{enabled:true,deployment:{contracts:{"intent-registry":contract}}} as never);
    await relay.cancelIntentAsync(intentCommitment);expect(requests).toEqual([{kind:"intent",payload:{args:["--intent_commitment",intentCommitment.slice(2)],contractId:contract,functionName:"cancel"}}]);
  });
});
