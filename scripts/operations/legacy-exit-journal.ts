import type { Hex } from "../../packages/protocol-types/src/index";

export interface LegacyExitAttempt {
  attempted?: boolean;
  completed?: boolean;
  txHash?: Hex;
  xdr?: string;
}

export function retainConfirmedLegacyRuns<T extends LegacyExitAttempt>(runs:T[]):Array<T|null> {
  if(runs.some(run=>run?.attempted && !run.completed)) {
    throw new Error("DRAIN:uncertain-exit-must-be-reconciled-before-unsubmitted-proof-refresh");
  }
  return runs.map(run=>run?.completed ? run : null);
}

export async function relayLegacyExitOnce(
  run:LegacyExitAttempt,
  relay:(beforeSubmit:(prepared:{txHash:Hex;xdr:string})=>Promise<void>)=>Promise<unknown>,
  persist:()=>void|Promise<void>,
):Promise<void> {
  if(run.attempted)return;
  await relay(async(prepared)=>{
    if(!/^0x[0-9a-f]{64}$/i.test(prepared.txHash) || !prepared.xdr) {
      throw new Error("DRAIN:exact-signed-transaction-hash-unavailable-no-resubmission");
    }
    run.attempted=true;run.txHash=prepared.txHash;run.xdr=prepared.xdr;
    await persist();
  });
}
