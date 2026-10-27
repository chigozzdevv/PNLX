import {expect,test} from "bun:test";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {risc0VerifierIdentity,RISC0_BATCH_MATCH_IMAGE_ID,RISC0_BATCH_MATCH_CIRCUIT_KEY,
  RISC0_STELLAR_VERIFIER_HASH,RISC0_STELLAR_VERIFIER_PARAMETERS_HASH} from "@/workers/risc0-matcher/risc0-proof";
import {createDeployManifest} from "../../scripts/deploy/manifest";

test("RISC0 receipt identity binds the guest image independently of unchanged router parameters",()=>{
  const parameters=`0x${"11".repeat(32)}` as const;
  const image=`0x${"22".repeat(32)}` as const;
  expect(risc0VerifierIdentity(parameters,image)).toBe("0x6ea8e413f15555c29fb7b70996002fc8bebd31a88188f86d6502ad8bf35c6bb0");
  expect(risc0VerifierIdentity(parameters,`0x${"33".repeat(32)}`)).not.toBe(risc0VerifierIdentity(parameters,image));
  expect(risc0VerifierIdentity(`0x${"44".repeat(32)}`,image)).not.toBe(risc0VerifierIdentity(parameters,image));
  for(const invalid of ["0x0",`0x${"00".repeat(32)}`,`0x${"gg".repeat(32)}`]) {
    expect(()=>risc0VerifierIdentity(invalid as `0x${string}`,image)).toThrow("invalid RISC0 verifier identity input");
  }
  expect(RISC0_STELLAR_VERIFIER_PARAMETERS_HASH).toBe(`0x${createHash("sha256")
    .update(readFileSync("vendor/stellar-risc0-verifier/contracts/groth16-verifier/parameters.json")).digest("hex")}`);
  expect(RISC0_STELLAR_VERIFIER_HASH).toBe(risc0VerifierIdentity(RISC0_STELLAR_VERIFIER_PARAMETERS_HASH,RISC0_BATCH_MATCH_IMAGE_ID));
  expect(RISC0_STELLAR_VERIFIER_HASH).not.toBe(RISC0_STELLAR_VERIFIER_PARAMETERS_HASH);
  // Identity metadata must not depend on artifacts built by other tests.
  const verifier=createDeployManifest(process.cwd(),{
    requireContracts:false,
    requireVerifierKeys:false,
  }).verifiers.find(entry=>entry.circuitId==="batch-match")!;
  expect(verifier.imageId).toBe(RISC0_BATCH_MATCH_IMAGE_ID);
  expect(verifier.verifierHash).toBe(RISC0_STELLAR_VERIFIER_HASH);
});

test("upgrade plan upgrades the adapter and rotates its recorded-proof namespace before governance activation",()=>{
  const result=spawnSync(process.execPath,["scripts/deploy/plan-testnet-upgrade.ts"],{encoding:"utf8"});
  expect(result.status).toBe(0);
  const plan=JSON.parse(result.stdout);
  const adapter=plan.contracts.find((entry:any)=>entry.name==="risc0-proof-verifier");
  expect(adapter.address).toMatch(/^C[A-Z2-7]{55}$/);
  const rotationIndex=plan.steps.findIndex((step:any)=>step.command.includes("set_image_id"));
  const rotation=plan.steps[rotationIndex].command as string[];
  expect(rotation[rotation.indexOf("--image_id")+1]).toBe(RISC0_BATCH_MATCH_IMAGE_ID.slice(2));
  expect(rotation[rotation.indexOf("--verifier_hash")+1]).toBe(RISC0_STELLAR_VERIFIER_HASH.slice(2));
  const bindingIndex=plan.steps.findIndex((step:any)=>step.command.includes("set_verifier")&&
    step.command.includes(RISC0_BATCH_MATCH_CIRCUIT_KEY.slice(2)));
  expect(bindingIndex).toBeGreaterThan(rotationIndex);
  expect(plan.steps[bindingIndex].command).toContain(RISC0_STELLAR_VERIFIER_HASH.slice(2));
  expect(plan.risc0.verifierHash).toBe(RISC0_STELLAR_VERIFIER_HASH);
});
