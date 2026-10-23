import { describe,expect,test } from "bun:test";
import { relayLegacyExitOnce,retainConfirmedLegacyRuns,type LegacyExitAttempt } from "../../scripts/operations/legacy-exit-journal";

const hash=`0x${"17".repeat(32)}` as const;
describe("legacy exit write-ahead recovery",()=>{
  test("lost response retains signed transaction and restart only reconciles without a second send",async()=>{
    let durable:LegacyExitAttempt={},sends=0;
    const run:LegacyExitAttempt={};
    const relay=async(before:(p:{txHash:typeof hash;xdr:string})=>Promise<void>)=>{
      await before({txHash:hash,xdr:"exact-signed-xdr"});
      expect(durable).toEqual({attempted:true,txHash:hash,xdr:"exact-signed-xdr"});
      sends++;throw new Error("response lost after chain accepted");
    };
    await expect(relayLegacyExitOnce(run,relay,()=>{durable={...run};})).rejects.toThrow("response lost");
    const restarted={...durable};
    await relayLegacyExitOnce(restarted,relay,()=>{throw new Error("must not persist a new candidate");});
    expect(sends).toBe(1);expect(restarted.txHash).toBe(hash);
  });
  test("failed durable write prevents financial send",async()=>{
    let sends=0;
    await expect(relayLegacyExitOnce({},async(before)=>{
      await before({txHash:hash,xdr:"signed-xdr"});sends++;
    },()=>{throw new Error("fsync failed");})).rejects.toThrow("fsync failed");
    expect(sends).toBe(0);
  });
  test("refresh retains confirmed winner openings and rejects any unresolved attempted transaction",()=>{
    const confirmed={attempted:true,completed:true,txHash:hash,xdr:"signed-xdr",outputs:[{secret:"kept-private"}]};
    const candidate={attempted:false,completed:false,outputs:[{secret:"superseded-private"}]};
    const runs=retainConfirmedLegacyRuns([confirmed,candidate,{...candidate}]);
    expect(runs[0]).toBe(confirmed);expect(runs[1]).toBeNull();expect(runs[2]).toBeNull();expect(confirmed.outputs[0].secret).toBe("kept-private");
    expect(()=>retainConfirmedLegacyRuns([confirmed,{attempted:true,completed:false,txHash:hash}])).toThrow("uncertain-exit");
  });
});
