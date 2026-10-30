import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFields } from "@pnlx/crypto";
import type { FundingSettlementRecord, Hex, MarketConfig } from "@pnlx/protocol-types";
import { FundingEngineService } from "@/workers/funding-engine/funding-engine.service";
import { ProtocolStore } from "@/shared/state/store";
import { FileProtocolStore } from "@/shared/state/persistent-store";
import { snapshotProtocolStore, applyProtocolStoreSnapshot } from "@/shared/state/protocol-snapshot";
import { normalizedSnapshotCounts, normalizedSnapshotFromRecords, normalizedSnapshotRecords } from "@/shared/mongo/snapshot";

const marketId = "xlm-usd-perp", interval = 60_000;
const key = (value: string): Hex => hashFields("funding-recovery-test", [value]);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value:T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(store = new ProtocolStore()) {
  const market: MarketConfig = { marketId, oraclePrice: 100_000_000n, fundingIndex: 0n,
    initialMarginRate: 100_000n, maintenanceMarginRate: 50_000n, maxLeverage: 10n };
  if (!store.markets.has(marketId)) store.addMarket(market);
  let chainIndex = store.markets.get(marketId)!.fundingIndex, price = market.oraclePrice;
  let now = 120_000, sends = 0, proofs = 0, ready = true, responseLost = false, land = true;
  let txStatus: "SUCCESS"|"FAILED"|"NOT_FOUND" = "NOT_FOUND";
  const confirmed = new Set<Hex>(), reads: Array<[string,bigint,bigint,Hex|undefined]> = [];
  const prover = { async proveFundingSettlementAsync(input: Record<string, unknown>) {
    proofs++; return { ...input, fundingDelta: (input.newFundingIndex as bigint) - (input.oldFundingIndex as bigint),
      proof: { circuitId: "funding-update", publicInputHash: key(`proof-${input.cycleId}`), proofDigest: key(`proof-${input.cycleId}`) } } as FundingSettlementRecord;
  } };
  const onchain = {
    enabled: true,
    fundingActivationReadyAsync: async () => ready,
    marketFundingIndexAsync: async () => chainIndex,
    marketPriceSnapshotAsync: async () => ({ price, timestamp: now / 1_000 }),
    isFundingSettledAsync: async (m:string,old:bigint,next:bigint,id?:Hex) => {
      reads.push([m,old,next,id]); return id !== undefined && confirmed.has(id);
    },
    fundingTransactionStatusAsync: async () => txStatus,
    async settleFundingAsync(record: FundingSettlementRecord, before:(value:{txHash:Hex;xdr:string})=>Promise<void>) {
      await before({ txHash: key(`tx-${record.cycleId}`), xdr: `signed-${record.cycleId}` });
      sends++;
      if (land) { chainIndex = record.newFundingIndex; confirmed.add(record.cycleId!); }
      if (responseLost) throw new Error("response lost with private runtime detail");
      return { relays: [] };
    },
  };
  const config = { intervalMs: interval, sampleIntervalMs: interval, premiumMode: "fixed" as const,
    premiumRate: 1_000n, settlementsOnchainRequired: true };
  const engine = () => new FundingEngineService({ store } as never, config, prover as never, onchain as never, () => now);
  return { store, market, prover, onchain, config, engine, confirmed, reads,
    proofs: () => proofs, sends: () => sends, index: () => chainIndex,
    at: (value:number) => { now = value; }, setIndex: (value:bigint) => { chainIndex = value; },
    setPrice: (value:bigint) => { price = value; }, setReady: (value:boolean) => { ready = value; },
    lose: (lands = true) => { responseLost = true; land = lands; }, status: (value:typeof txStatus) => { txStatus = value; },
  };
}

describe("durable async funding cycles", () => {
  test("coalesces workers, yields while proving, and journals the exact cycle before cash submission", async () => {
    const f = fixture(), gate = deferred<void>();
    const prove = f.prover.proveFundingSettlementAsync;
    f.prover.proveFundingSettlementAsync = async (input) => { await gate.promise; return prove(input); };
    let completed = false;
    const first = f.engine().runOnce({ appliedAt: 120_000 }), second = f.engine().runOnce({ appliedAt: 120_000 });
    void first.then(() => { completed = true; });
    await tick();
    expect(completed).toBe(false); expect(f.sends()).toBe(0);
    expect([...f.store.fundingCycles.values()][0]?.status).toBe("prepared");
    expect(f.store.markets.get(marketId)?.fundingIndex).toBe(0n);
    gate.resolve(); const [a,b] = await Promise.all([first,second]);
    expect(f.proofs()).toBe(1); expect(f.sends()).toBe(1); expect(a).toEqual(b);
    const journal = [...f.store.fundingCycles.values()][0]!;
    expect(journal).toMatchObject({ status: "settled", submissionAttempted: true,
      settlementTxHash: key(`tx-${journal.cycleId}`), preparedXdr: `signed-${journal.cycleId}` });
    expect(f.reads.every((read) => read[3] === journal.cycleId)).toBe(true);
    expect(f.store.fundingCursors.get(marketId)?.windowEnd).toBe(120_000);
    expect(f.store.fundingUpdates.size).toBe(1);
  });

  test("an unknown submission stays held and later exact cycle confirmation recovers without a second send or proof", async () => {
    const f = fixture(); f.lose(false);
    await expect(f.engine().runOnce({ appliedAt:120_000 })).rejects.toThrow("response lost");
    const journal = [...f.store.fundingCycles.values()][0]!;
    expect(journal.status).toBe("attempted"); expect(f.store.markets.get(marketId)?.fundingIndex).toBe(0n);
    await expect(f.engine().runOnce({ appliedAt:180_000 })).rejects.toThrow("outcome is unknown");
    expect(f.sends()).toBe(1); expect(f.proofs()).toBe(1);
    f.confirmed.add(journal.cycleId); f.setIndex(journal.newFundingIndex);
    await f.engine().runOnce({ appliedAt:180_000 });
    expect(f.sends()).toBe(1); expect(f.proofs()).toBe(1);
    expect(f.store.markets.get(marketId)?.fundingIndex).toBe(journal.newFundingIndex);
    expect(f.store.fundingUpdates.size).toBe(1);
  });

  test("a landed response lost before local commit is recovered idempotently after a File restart", async () => {
    const directory = mkdtempSync(join(tmpdir(),"pnlx-funding-journal-"));
    try {
      const path = join(directory,"state.json"), f = fixture(new FileProtocolStore(path)); f.lose();
      await expect(f.engine().runOnce({ appliedAt:120_000 })).rejects.toThrow();
      const restored = new FileProtocolStore(path), journal = [...restored.fundingCycles.values()][0]!;
      expect(journal).toMatchObject({ status:"attempted", submissionAttempted:true });
      const engine = new FundingEngineService({store:restored} as never,f.config,f.prover as never,f.onchain as never,()=>120_000);
      await engine.runOnce(); await engine.runOnce();
      const reload = new FileProtocolStore(path);
      expect(reload.markets.get(marketId)?.fundingIndex).toBe(journal.newFundingIndex);
      expect(reload.fundingCycles.get(journal.cycleId)?.status).toBe("settled");
      expect(reload.fundingCursors.get(marketId)?.windowEnd).toBe(journal.windowEnd);
      expect(reload.fundingUpdates.size).toBe(1); expect(f.sends()).toBe(1);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });

  test("zero cycles and paused gaps never multiply a later premium by an old elapsed duration", async () => {
    const store = new ProtocolStore(); fixture(store);
    const make = (premiumRate:bigint) => new FundingEngineService({store} as never,
      {intervalMs:interval,sampleIntervalMs:interval,premiumMode:"fixed",premiumRate});
    await make(1_000n).runOnce({appliedAt:60_000});
    await make(0n).runOnce({appliedAt:120_000});
    expect(store.fundingCursors.get(marketId)?.windowEnd).toBe(120_000);
    expect((await make(1_000n).runOnce({appliedAt:180_000})).results[0]?.update?.fundingDelta).toBe(100_000n);
    expect((await make(1_000n).runOnce({appliedAt:600_000})).results[0]?.update?.fundingDelta).toBe(100_000n);
    expect(store.markets.get(marketId)?.fundingIndex).toBe(300_000n);
    expect([...store.fundingCycles.values()].some((cycle)=>cycle.status==="skipped"&&cycle.windowStart===180_000&&cycle.windowEnd===540_000)).toBe(true);
  });

  test("signed index oscillation uses a new cycle identity even when an old/new tuple repeats", async () => {
    const f = fixture(); const positive = f.engine();
    f.at(60_000); await positive.runOnce({appliedAt:60_000});
    const negative = new FundingEngineService({store:f.store} as never,{...f.config,premiumRate:-1_000n},f.prover as never,f.onchain as never,()=>120_000);
    f.at(120_000); await negative.runOnce({appliedAt:120_000});
    f.at(180_000); await positive.runOnce({appliedAt:180_000});
    expect(f.index()).toBe(100_000n); expect(f.sends()).toBe(3);
    const cycles = [...f.store.fundingCycles.values()];
    expect(cycles.map((cycle)=>[cycle.oldFundingIndex,cycle.newFundingIndex])).toEqual([[0n,100_000n],[100_000n,0n],[0n,100_000n]]);
    expect(new Set(cycles.map((cycle)=>cycle.cycleId)).size).toBe(3);
  });

  test("historical confirmation cannot advance local state when the current chain index disagrees", async () => {
    const f = fixture(); f.lose(false);
    await expect(f.engine().runOnce({appliedAt:120_000})).rejects.toThrow();
    const cycle = [...f.store.fundingCycles.values()][0]!; f.confirmed.add(cycle.cycleId);
    await expect(f.engine().runOnce({appliedAt:180_000})).rejects.toThrow("current chain index");
    expect(f.store.markets.get(marketId)?.fundingIndex).toBe(0n); expect(f.store.fundingUpdates.size).toBe(0);
  });

  test("requires all upgraded contract protections before any real proof or settlement", async () => {
    const f = fixture(); f.setReady(false);
    await expect(f.engine().runOnce({appliedAt:120_000})).rejects.toThrow("activation protections");
    expect(f.proofs()).toBe(0); expect(f.sends()).toBe(0); expect(f.store.fundingCycles.size).toBe(0);
  });

  test("a failed journal flush prevents proof work and a failed pre-send flush prevents the send", async () => {
    for (const failAt of ["prepared","attempted"]) {
      const f = fixture();
      Object.assign(f.store,{async flush(){ if([...f.store.fundingCycles.values()].some((cycle)=>cycle.status===failAt)) throw new Error("checkpoint unavailable"); }});
      await expect(f.engine().runOnce({appliedAt:120_000})).rejects.toThrow("checkpoint unavailable");
      expect(f.sends()).toBe(0); expect(f.store.markets.get(marketId)?.fundingIndex).toBe(0n);
      expect(f.proofs()).toBe(failAt==="prepared"?0:1);
    }
  });

  test("blocks index mutation behind an uncertain batch and never marks funding attempted", async () => {
    const f=fixture(), id=key("unknown-batch");
    f.store.batchExecutionRuns.set(id,{runId:id,batchId:"unknown",marketId,startedAt:1,status:"failed",submissionAttempted:true,settlementDigest:key("batch-digest")});
    await expect(f.engine().runOnce({appliedAt:120_000})).rejects.toThrow("pending batch");
    expect(f.sends()).toBe(0); expect([...f.store.fundingCycles.values()].every((cycle)=>!cycle.submissionAttempted)).toBe(true);
  });

  test("stale oracle prices retire an unattempted proof and a stopped worker cannot submit a late proof", async () => {
    const f=fixture(); let reads=0;
    f.onchain.marketPriceSnapshotAsync=async()=>({price:++reads===1?100_000_000n:101_000_000n,timestamp:120});
    await expect(f.engine().runOnce({appliedAt:120_000})).rejects.toThrow("oracle changed before submission");
    expect(f.sends()).toBe(0); expect([...f.store.fundingCycles.values()][0]?.status).toBe("retired");
    const g=fixture(), gate=deferred<void>(), prove=g.prover.proveFundingSettlementAsync;
    g.prover.proveFundingSettlementAsync=async(input)=>{await gate.promise;return prove(input);};
    const engine=g.engine(), work=engine.runOnce({appliedAt:120_000}); await tick(); engine.stop(); gate.resolve();
    await expect(work).rejects.toThrow("stopped"); expect(g.sends()).toBe(0);
    expect([...g.store.fundingCycles.values()][0]?.status).toBe("retired");
  });

  test("retires only a definitively FAILED exact transaction, not NOT_FOUND or changed chain state", async () => {
    for(const outcome of ["FAILED","NOT_FOUND","changed-index"] as const){
      const f=fixture();f.lose(false);await expect(f.engine().runOnce({appliedAt:120_000})).rejects.toThrow();
      f.status(outcome==="NOT_FOUND"?"NOT_FOUND":"FAILED");if(outcome==="changed-index")f.setIndex(1n);
      if(outcome==="FAILED"){
        expect((await f.engine().runOnce({appliedAt:180_000})).results[0]).toMatchObject({skipped:true,reason:"funding transaction failed"});
        expect([...f.store.fundingCycles.values()][0]).toMatchObject({status:"retired",failureConfirmed:true});
        expect(f.store.fundingCursors.get(marketId)?.windowEnd).toBe(120_000);
      }else{
        await expect(f.engine().runOnce({appliedAt:180_000})).rejects.toThrow("unknown");
        expect([...f.store.fundingCycles.values()][0]?.status).toBe("attempted");
      }
      expect(f.store.markets.get(marketId)?.fundingIndex).toBe(0n);expect(f.sends()).toBe(1);
    }
  });

  test("bootstraps after activation without charging historical or partially observed windows", async () => {
    const f=fixture();f.at(120_001);const engine=f.engine();
    engine.start();try{await tick();await tick();
      expect(f.store.fundingCursors.get(marketId)?.windowEnd).toBe(180_000);
      expect(engine.status().nextFundingAt).toBe(240_000);
      expect((await engine.runOnce({appliedAt:180_000})).results[0]?.skipped).toBe(true);
      expect(f.sends()).toBe(0);
    }finally{engine.stop();}
  });

  test("a stopped and restarted generation cannot resurrect an orphan funding timer or overwrite health", async () => {
    const timers = fakeFundingTimers(), f = fixture(), gate = deferred<void>();
    const prove = f.prover.proveFundingSettlementAsync;
    f.prover.proveFundingSettlementAsync = async (input) => { await gate.promise; return prove(input); };
    const engine = f.engine();
    try {
      engine.start(); await settleTasks(); expect(timers.size()).toBe(1);
      f.at(180_000); timers.fire(); await settleTasks(); expect(timers.size()).toBe(0);
      engine.stop(); f.at(240_000); engine.start(); await settleTasks(); expect(timers.size()).toBe(1);
      gate.resolve(); await settleTasks();
      expect(timers.size()).toBe(1); expect(engine.status().settlementBlocked).toBe(false);
      const cancelledCallback = timers.next();
      engine.stop(); expect(timers.size()).toBe(0);
      f.at(360_000); cancelledCallback(); await settleTasks();
      expect(f.sends()).toBe(0); expect(timers.size()).toBe(0);
      expect(engine.status()).toMatchObject({settlementRunning:false,nextFundingAt:null});
    } finally { gate.resolve(); engine.stop(); await settleTasks(); timers.restore(); }
  });

  test("another service activation or stop cannot retire an actively owned preparation", async () => {
    const timers=fakeFundingTimers(),f=fixture(),gate=deferred<void>(),prove=f.prover.proveFundingSettlementAsync;
    f.prover.proveFundingSettlementAsync=async(input)=>{await gate.promise;return prove(input);};
    const a=f.engine(),b=f.engine(),work=a.runOnce({appliedAt:120_000});
    try {await settleTasks();b.start();await settleTasks();b.stop();
      expect([...f.store.fundingCycles.values()][0]?.status).toBe("prepared");
      gate.resolve();await work;expect(f.sends()).toBe(1);
    }finally{gate.resolve();a.stop();b.stop();await settleTasks();timers.restore();}
  });

  test("an empty deployment schedules a finite interval instead of an immediate timer loop", async () => {
    const timers=fakeFundingTimers(),store=new ProtocolStore();
    const engine=new FundingEngineService({store} as never,{intervalMs:60_000,sampleIntervalMs:60_000,premiumMode:"fixed",premiumRate:0n},undefined,undefined,()=>120_000);
    try{engine.start();await settleTasks();expect(engine.status().nextFundingAt).toBe(180_000);expect(timers.size()).toBe(1);}
    finally{engine.stop();timers.restore();}
  });

  test("an old activation failure cannot block a newer successful activation", async () => {
    const timers=fakeFundingTimers(), f=fixture(), gate=deferred<boolean>();let calls=0;
    f.onchain.fundingActivationReadyAsync=()=>++calls===1?gate.promise:Promise.resolve(true);
    const engine=f.engine();
    try {engine.start();await settleTasks();engine.stop();engine.start();await settleTasks();
      expect(engine.status().settlementRunning).toBe(true);
      gate.resolve(false);await settleTasks();
      expect(engine.status()).toMatchObject({settlementRunning:true,settlementBlocked:false,lastError:null});
      expect(timers.size()).toBe(1);
    }finally{gate.resolve(false);engine.stop();await settleTasks();timers.restore();}
  });

  test("funding journals round-trip in normalized Mongo records and legacy snapshots create no fictional cursor", async () => {
    const f=fixture();f.lose(false);await expect(f.engine().runOnce({appliedAt:120_000})).rejects.toThrow();
    const snapshot=snapshotProtocolStore(f.store), counts=normalizedSnapshotCounts(snapshotProtocolStore(new ProtocolStore()));
    counts.fundingCycles=snapshot.fundingCycles!.length;counts.fundingCursors=snapshot.fundingCursors!.length;
    const records={fundingCycles:normalizedSnapshotRecords("test","funding",1,"fundingCycles",snapshot.fundingCycles!),
      fundingCursors:normalizedSnapshotRecords("test","funding",1,"fundingCursors",snapshot.fundingCursors!)};
    expect(normalizedSnapshotFromRecords(records,counts).fundingCycles).toEqual(snapshot.fundingCycles);
    const restored=new ProtocolStore();applyProtocolStoreSnapshot(restored,{markets:snapshot.markets,fundingUpdates:snapshot.fundingUpdates});
    expect(restored.fundingCursors.size).toBe(0);expect(restored.fundingCycles.size).toBe(0);
  });
});

async function settleTasks() { for(let turn=0;turn<60;turn++)await Promise.resolve(); }
function fakeFundingTimers(){
  const tasks=new Map<ReturnType<typeof setTimeout>,()=>void>();
  const schedule=spyOn(globalThis,"setTimeout").mockImplementation(((callback:()=>void)=>{
    const handle={unref(){}} as ReturnType<typeof setTimeout>;tasks.set(handle,callback);return handle;
  }) as typeof setTimeout);
  const cancel=spyOn(globalThis,"clearTimeout").mockImplementation(((handle:ReturnType<typeof setTimeout>)=>{tasks.delete(handle);}) as typeof clearTimeout);
  return {size:()=>tasks.size,next:()=>tasks.values().next().value!,fire(){const next=tasks.entries().next().value!;tasks.delete(next[0]);next[1]();},
    restore(){schedule.mockRestore();cancel.mockRestore();}};
}
