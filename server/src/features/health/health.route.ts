import type { Router } from "@/shared/http/router";
import type { ServerEnv } from "@/config/env";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import { HealthController } from "@/features/health/health.controller";
import type { ProtocolPersistenceStatus } from "@/shared/mongo/store";

interface PersistenceStatusProvider {
  persistenceStatus(): ProtocolPersistenceStatus;
}

export function registerHealthRoute(
  router: Router,
  env: ServerEnv,
  onchain?: Pick<OnchainRelayService, "enabled" | "tokenDigest"> & Partial<Pick<OnchainRelayService,"marketPriceSnapshotAsync">>,
  store?: unknown,
  operations?: () => unknown,
): void {
  const persistence = isPersistenceStatusProvider(store) ? store : undefined;
  const controller = new HealthController(env, onchain, persistence, operations);
  router.add("GET", "/health", () => controller.get());
  router.add("GET", "/health/live", async () => {
    const checks:Record<string,{ok:boolean;detail?:string}>={};
    const observedAt=Date.now();
    const jobs:Promise<void>[]=[];
    if(env.oracleOnchainRequired || env.settlementsOnchainRequired) {
      jobs.push((async()=>{
        if(!onchain?.enabled || !onchain.marketPriceSnapshotAsync)throw new Error("on-chain market reader unavailable");
        const snapshot=await deadline(onchain.marketPriceSnapshotAsync(env.marketId),5_000);
        const age=Math.floor(Date.now()/1000)-snapshot.timestamp;
        checks.oracle={ok:snapshot.price>0n && age>=-5 && age<=env.oraclePriceMaxAgeSeconds,
          detail:`observed price age ${age}s`};
      })().catch(()=>{checks.oracle={ok:false,detail:"on-chain market read failed or timed out"};}));
    }
    if(env.privateMatchingRequired) {
      jobs.push((async()=>{
        if(!env.matcherServiceUrl)throw new Error("matcher endpoint unavailable");
        const response=await fetch(`${env.matcherServiceUrl.replace(/\/$/,"")}/health`,{
          signal:AbortSignal.timeout(5_000),headers:env.matcherServiceToken?{authorization:`Bearer ${env.matcherServiceToken}`}:{},
        });
        checks.matcher={ok:response.ok};
        await response.body?.cancel();
      })().catch(()=>{checks.matcher={ok:false,detail:"matcher read failed or timed out"};}));
    }
    await Promise.allSettled(jobs);
    checks.persistence={ok:persistence?.persistenceStatus().healthy ?? !env.mongodbUri,
      detail:"latest observed persistence status"};
    const ok=Object.values(checks).every((check)=>check.ok);
    return Response.json({ok,observedAt,scope:"dependency-observation",checks,
      verifierAuthorityChecked:false,...(operations?{operations:operations()}:{})},{status:ok?200:503});
  });
}

async function deadline<T>(operation:Promise<T>,milliseconds:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new Error("health read timeout")),milliseconds);
  })]);}finally{if(timer)clearTimeout(timer);}
}

function isPersistenceStatusProvider(value: unknown): value is PersistenceStatusProvider {
  return Boolean(
    value &&
    typeof value === "object" &&
    "persistenceStatus" in value &&
    typeof value.persistenceStatus === "function",
  );
}
