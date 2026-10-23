import { commitConditionalOrder, hashFields } from "@pnlx/crypto";
import { PRICE_SCALE, RATE_SCALE } from "@pnlx/market-math";
import type { ConditionalOrderWitness, PositionLifecycleRecord } from "@pnlx/protocol-types";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { PositionClosesService } from "@/features/position-closes/position-closes.service";
import type { ConditionalOrdersService } from "@/features/conditional-orders/conditional-orders.service";
import { reconstructPositionOpening } from "@/features/account-keys/account-key-recovery";
import { deriveDelegatedConditionalSalt, findDelegatedConditionalPolicy } from "@/shared/protocol/delegated-policies";

export function protectionDecision(input: {side:"long"|"short";size:bigint;entryPrice:bigint;margin:bigint;
  fundingIndex:bigint;currentFundingIndex:bigint;markPrice:bigint;maintenanceRate:bigint;
  stopLossPrice?:bigint;takeProfitPrice?:bigint}): "liquidation"|"stop-loss"|"take-profit"|undefined {
  const direction=input.side==="long"?1n:-1n;
  const pnl=input.size*(input.markPrice-input.entryPrice)*direction/PRICE_SCALE;
  const funding=input.size*(input.currentFundingIndex-input.fundingIndex)*direction/PRICE_SCALE;
  const equity=input.margin+pnl-funding;
  const maintenance=(input.size*input.markPrice/PRICE_SCALE)*input.maintenanceRate/RATE_SCALE;
  if (equity<=0n || equity<maintenance) return "liquidation";
  if (input.stopLossPrice!==undefined && (input.side==="long" ? input.markPrice<=input.stopLossPrice : input.markPrice>=input.stopLossPrice)) return "stop-loss";
  if (input.takeProfitPrice!==undefined && (input.side==="long" ? input.markPrice>=input.takeProfitPrice : input.markPrice<=input.takeProfitPrice)) return "take-profit";
}

export class ProtectionKeeperService {
  private timer?: ReturnType<typeof setInterval>;
  private running=false;
  private cursor=0;
  readonly status={lastStartedAt:0,lastCompletedAt:0,lastSuccessAt:0,failures:0,processed:0};
  constructor(private readonly executor:ExecutorService,private readonly closes:PositionClosesService,
    private readonly conditional:ConditionalOrdersService,private readonly onchain?:OnchainRelayService,
    private readonly intervalMs=5_000) {}

  start():void {
    if (this.timer) return;
    const tick=()=>{void this.runOnce().catch(()=>{this.status.failures++;});};
    this.timer=setInterval(tick,this.intervalMs);
    (this.timer as {unref?:()=>void}).unref?.();
    tick();
  }
  stop():void {if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  async runOnce():Promise<void> {
    if(this.running)return;
    this.running=true;this.status.lastStartedAt=Date.now();
    try {
      try {await this.closes.recoverPendingPairs();} catch {this.status.failures++;}
      const positions=[...this.executor.store.positionLifecycle.values()].filter((position)=>position.status==="open");
      const count=Math.min(50,positions.length);
      for(let index=0;index<count;index++) {
        const position=positions[(this.cursor+index)%positions.length]!;
        if(position.status!=="open")continue;
        try {await this.protect(position);this.status.processed++;this.status.lastSuccessAt=Date.now();}
        catch {this.status.failures++;}
      }
      this.cursor=positions.length?(this.cursor+count)%positions.length:0;
      this.status.lastCompletedAt=Date.now();
    } finally {this.running=false;}
  }

  private async protect(position:PositionLifecycleRecord):Promise<void> {
    const store=this.executor.store;
    const market=store.markets.get(position.marketId);
    const opening=reconstructPositionOpening(store,position);
    if(!market || !opening)throw new Error("protection opening unavailable");
    if (this.onchain?.enabled && (!this.onchain.marketPriceAsync || !this.onchain.marketFundingIndexAsync)) {
      throw new Error("asynchronous protection market reads are unavailable");
    }
    const [markPrice, currentFundingIndex] = this.onchain?.enabled
      ? await Promise.all([this.onchain.marketPriceAsync(position.marketId), this.onchain.marketFundingIndexAsync(position.marketId)])
      : [market.oraclePrice, market.fundingIndex];
    const risk = {...opening,currentFundingIndex,markPrice,maintenanceRate:market.maintenanceMarginRate};
    if (protectionDecision(risk)==="liquidation") {
      await this.closes.closeHosted(position,hashFields("keeper-pair-liquidation",[position.positionCommitment]),false,true);
      return;
    }
    const policy=findDelegatedConditionalPolicy(store,position.sourceIntentCommitment);
    if(policy && (policy.ownerCommitment!==position.ownerCommitment || policy.marketId!==position.marketId)) {
      throw new Error("protection authority scope mismatch");
    }
    const witnesses=new Map<string,ConditionalOrderWitness>();
    for(const kind of ["stop-loss","take-profit"] as const) {
      const price=kind==="stop-loss"?policy?.stopLossPrice:policy?.takeProfitPrice;
      const salt=kind==="stop-loss"?policy?.stopLossSalt:policy?.takeProfitSalt;
      if(!price || !salt)continue;
      const witness:ConditionalOrderWitness={marketId:position.marketId,positionNullifier:position.positionNullifier,
        side:opening.side,size:opening.size,reduceOnly:true,kind,triggerPrice:BigInt(price),markPrice,
        salt:deriveDelegatedConditionalSalt(salt,position.positionCommitment,position.positionNullifier)};
      const closeCommitment=commitConditionalOrder(witness);
      witnesses.set(kind,witness);
      const triggered=store.conditionalCloses.get(closeCommitment);
      if (triggered) {
        if (triggered.marketId!==position.marketId || triggered.positionNullifier!==position.positionNullifier) {
          throw new Error("triggered protection scope mismatch");
        }
        await this.closes.closeHosted(position,closeCommitment,true);
        return;
      }
    }
    for (const witness of witnesses.values()) {
      if (!this.conditional.registerAsync) throw new Error("asynchronous conditional registration is unavailable");
      await this.conditional.registerAsync({marketId:position.marketId,positionNullifier:position.positionNullifier,
        closeCommitment:commitConditionalOrder(witness)});
    }
    const decision=protectionDecision({...risk,
      stopLossPrice:policy?.stopLossPrice?BigInt(policy.stopLossPrice):undefined,
      takeProfitPrice:policy?.takeProfitPrice?BigInt(policy.takeProfitPrice):undefined});
    if(!decision)return;
    const witness=witnesses.get(decision)!;
    if (!this.conditional.triggerAsync) throw new Error("asynchronous conditional trigger is unavailable");
    const triggered=await this.conditional.triggerAsync(witness);
    await this.closes.closeHosted(position,triggered.closeCommitment,true);
  }
}
