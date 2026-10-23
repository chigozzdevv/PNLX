import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { circuitKey, loadCircuit, type CircuitId } from "@pnlx/proof-system";
import { RISC0_BATCH_MATCH_CIRCUIT_KEY, RISC0_BATCH_MATCH_IMAGE_ID, RISC0_STELLAR_VERIFIER_HASH,
  RISC0_STELLAR_VERIFIER_PARAMETERS_HASH } from "@/workers/risc0-matcher/risc0-proof";

// This program only prints a review plan. It has no transaction execution path.
if (process.argv.includes("--execute")) throw new Error("This planner cannot submit transactions");
const root = process.cwd();
const deployment = JSON.parse(readFileSync(join(root,"deployments/testnet.json"),"utf8"));
if (deployment.network !== "testnet") throw new Error("testnet deployment required");
const blockers:string[] = [];
const hash = (path:string) => `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const bare = (value:string) => value.replace(/^0x/,"");
const arg = (name:string) => {const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const proofPath=join(root,".pnlx/verification/proof-evidence.json");
const proofEvidence=existsSync(proofPath)?JSON.parse(readFileSync(proofPath,"utf8")):undefined;
const circuitIds:CircuitId[]=["intent-validity","position-close","liquidation-check","conditional-close","position-close-pair"];
const circuits=circuitIds.map(id=>{
  const circuit=loadCircuit(root,id);
  const evidence=proofEvidence?.artifacts?.find((value:any)=>value.circuitId===id);
  if (!evidence || evidence.sourceHash!==circuit.sourceHash || evidence.vkHash!==circuit.verifierHash) {
    blockers.push(`${id}: regenerate proof evidence for the current source and VK`);
  } else {
    for (const [pathKey,hashKey] of [["proofPath","proofHash"],["publicInputsPath","publicInputsHash"],["vkPath","vkHash"]]) {
      if (!existsSync(evidence[pathKey]) || hash(evidence[pathKey])!==evidence[hashKey]) blockers.push(`${id}: ${pathKey} changed`);
    }
    const bytecode=join(root,circuit.dir,"target",`${circuit.packageName}.json`);
    if (!existsSync(bytecode)||hash(bytecode)!==evidence.bytecodeHash) blockers.push(`${id}: compiled bytecode changed`);
    if (evidence.publicInputsHash!==evidence.expectedPublicInputHash) blockers.push(`${id}: public ABI mismatch`);
  }
  return {id,circuitKey:circuitKey(id),sourceHash:circuit.sourceHash,vkHash:circuit.verifierHash,
    vkPath:join(root,circuit.dir,"target/bb/vk")};
});
function treeHash(path:string):string {
  const result=createHash("sha256");
  const walk=(directory:string):string[]=>readdirSync(directory,{withFileTypes:true})
    .flatMap(entry=>entry.name==="target"||entry.name==="test_snapshots"||entry.name===".git"||entry.name===".DS_Store"?[]:entry.isDirectory()?walk(join(directory,entry.name)):
      entry.isFile()?[join(directory,entry.name)]:[]).sort();
  for(const file of walk(path)){result.update(file.slice(path.length+1));result.update("\0");result.update(readFileSync(file));result.update("\0");}
  return `0x${result.digest("hex")}`;
}
const guestSourceHash=treeHash(join(root,"risc0/batch-match"));
const guestEvidencePath=arg("--guest-evidence");
const guest=guestEvidencePath?JSON.parse(readFileSync(resolve(guestEvidencePath),"utf8")):undefined;
if (!guest || guest.sourceHash!==guestSourceHash || !/^0x[0-9a-f]{64}$/.test(guest.imageId??"") ||
  !guest.elfPath || !existsSync(guest.elfPath) || hash(guest.elfPath)!==guest.elfHash) {
  blockers.push("A rebuilt RISC0 guest with matching source, image ID and ELF provenance is required");
} else if(guest.developmentMode!==false || guest.receiptVerified!==true) {
  blockers.push("Independently verify a fresh production RISC0 receipt for the rebuilt guest with development mode disabled");
}
if(guest && guest.imageId!==RISC0_BATCH_MATCH_IMAGE_ID)blockers.push("Guest evidence image differs from the pinned runtime image");
const snapshotPath=arg("--snapshot");
const snapshot=snapshotPath?JSON.parse(readFileSync(resolve(snapshotPath),"utf8")):undefined;
if (!snapshot || snapshot.network!=="testnet" || !Number.isSafeInteger(snapshot.ledger) ||
  !snapshot.encryptedBackupSha256 || !snapshot.reviewedBy ||
  !Number.isFinite(Date.parse(snapshot.createdAt)) || Date.now()-Date.parse(snapshot.createdAt)>3_600_000 ||
  Date.parse(snapshot.createdAt)>Date.now()) {
  blockers.push("A reviewed recent ledger snapshot and encrypted recovery backup are required");
} else {
  const amounts=[snapshot.poolBalance,snapshot.secureNoteLiability,snapshot.activePositionLiability,
    snapshot.feeLiability,snapshot.unreconciledLegacyLiability];
  if (amounts.some(value=>typeof value!=="string"||!/^\d+$/.test(value))) blockers.push("Snapshot amounts must be nonnegative integer strings");
  else if(BigInt(snapshot.poolBalance)<BigInt(snapshot.secureNoteLiability)+BigInt(snapshot.activePositionLiability)+
    BigInt(snapshot.feeLiability)||BigInt(snapshot.unreconciledLegacyLiability)!==0n) blockers.push("Unreconciled or undercollateralized liabilities block activation");
  if(snapshot.legacyOpenPositions!==0||snapshot.pendingSettlementCount!==0) blockers.push("Legacy positions and in-flight settlements require explicit recovery before activation");
  for(const field of ["secureNoteRoot","positionRoot","collateralDigest"]) {
    if(!/^0x[0-9a-f]{64}$/.test(snapshot[field]??"")) blockers.push(`Missing snapshot ${field}`);
  }
}
const contractNames=["market","position-state","intent-registry","batch-settlement","conditional-order","position-close","liquidation","risc0-proof-verifier"];
const contracts=contractNames.map(name=>{
  const path=join(root,"contracts/target/stellar",`${name.replaceAll("-","_")}.wasm`);
  if(!existsSync(path))blockers.push(`${name}: build current contract WASM`);
  return {name,address:name==="risc0-proof-verifier"?deployment.verifiers["batch-match-risc0-verifier"]:
    deployment.contracts[name],wasmPath:path,wasmHash:existsSync(path)?hash(path):undefined};
});
const contractSourceHash=treeHash(join(root,"contracts"));
const contractEvidencePath=arg("--contract-build-evidence");
const contractEvidence=contractEvidencePath?JSON.parse(readFileSync(resolve(contractEvidencePath),"utf8")):undefined;
if(!contractEvidence||contractEvidence.sourceHash!==contractSourceHash||contractEvidence.lockedBuild!==true||
  contracts.some(contract=>contractEvidence.wasmHashes?.[contract.name]!==contract.wasmHash)) {
  blockers.push("Record a fresh locked contract build with matching source fingerprint and all upgraded WASM hashes");
}
const governance=deployment.contracts.governance;
const admin=deployment.source;
const upgrade="<REVIEWED_UPGRADE_SIGNER_ALIAS>";
const invoke=(id:string,signer:string,method:string,args:string[]=[])=>["stellar","contract","invoke","--id",id,
  "--network","testnet","--source",signer,"--send","yes","--",method,...args];
const steps:Array<{purpose:string;command:string[]}>=[{
  purpose:"Pause proof acceptance after draining workers and taking the reviewed snapshot",
  command:invoke(governance,admin,"set_paused",["--paused","true"]),
}];
for(const contract of contracts){
  steps.push({purpose:`Upload ${contract.name} only after a fresh locked build`,command:["stellar","contract","upload",
    "--wasm",contract.wasmPath,"--network","testnet","--source",admin,"--optimize=false"]});
  steps.push({purpose:`Upgrade ${contract.name}; retain contract ID, storage and balances`,command:invoke(contract.address,upgrade,"upgrade",
    ["--new_wasm_hash",bare(contract.wasmHash??`<${contract.name.toUpperCase()}_WASM_HASH>`)])});
}
steps.push({purpose:"Pack deterministic empty-node cache; preserve current/historical roots, frontiers and balances",
  command:invoke(deployment.contracts["position-state"],admin,"pack_empty_nodes")});
for(const circuit of circuits){
  const verifier=deployment.verifiers[`${circuit.id}-proof-verifier`]??"<NEW_PAIR_VERIFIER_CONTRACT>";
  if(circuit.id==="position-close-pair"){
    steps.push({purpose:"Deploy a new combined-close verifier; save its returned contract ID",command:["stellar","contract","deploy",
      "--wasm",join(root,"contracts/target/stellar/proof_verifier.wasm"),"--network","testnet","--source",admin]});
    steps.push({purpose:"Initialize the combined verifier with the verified VK",command:invoke(verifier,admin,"init",[
      "--governance",governance,"--proof_ledger",deployment.contracts["proof-ledger"],"--circuit_id",bare(circuit.circuitKey),
      "--verifier_hash",bare(circuit.vkHash),"--vk_bytes-file-path",circuit.vkPath])});
  }else steps.push({purpose:`Rotate ${circuit.id} VK`,command:invoke(verifier,upgrade,"rotate_vk",[
    "--verifier_hash",bare(circuit.vkHash),"--vk_bytes-file-path",circuit.vkPath])});
  steps.push({purpose:`Bind ${circuit.id} governance verifier`,command:invoke(governance,admin,"set_verifier",[
    "--circuit_id",bare(circuit.circuitKey),"--verifier_hash",bare(circuit.vkHash),"--authority",verifier])});
}
steps.push({purpose:"Atomically rotate the matcher image and recorded-proof namespace",command:invoke(
  deployment.verifiers["batch-match-risc0-verifier"],upgrade,"set_image_id",[
    "--image_id",bare(RISC0_BATCH_MATCH_IMAGE_ID),"--verifier_hash",bare(RISC0_STELLAR_VERIFIER_HASH)])});
steps.push({purpose:"Retire old recorded matcher receipts by activating the image-bound verifier identity",command:invoke(
  governance,admin,"set_verifier",["--circuit_id",bare(RISC0_BATCH_MATCH_CIRCUIT_KEY),
    "--verifier_hash",bare(RISC0_STELLAR_VERIFIER_HASH),"--authority",deployment.verifiers["batch-match-risc0-verifier"]])});
steps.push({purpose:"Configure immutable registry validity composition after verifying it is unset",command:invoke(
  deployment.contracts["intent-registry"],admin,"configure_validity",["--governance",governance,"--proof_ledger",
    deployment.contracts["proof-ledger"],"--circuit_id",bare(circuitKey("intent-validity")),"--collateral_digest",
    bare(snapshot?.collateralDigest??"<CANONICAL_COLLATERAL_DIGEST>")])});
steps.push({purpose:"Configure immutable combined-close circuit after verifying it is unset",command:invoke(
  deployment.contracts["position-close"],admin,"configure_pair_circuit",["--circuit_id",bare(circuitKey("position-close-pair"))])});
process.stdout.write(JSON.stringify({planOnly:true,network:"testnet",activationBlocked:blockers.length>0,blockers,
  deploymentFingerprint:hash(join(root,"deployments/testnet.json")),guestSourceHash,contractSourceHash,circuits,contracts,steps,
  risc0:{imageId:RISC0_BATCH_MATCH_IMAGE_ID,parametersHash:RISC0_STELLAR_VERIFIER_PARAMETERS_HASH,verifierHash:RISC0_STELLAR_VERIFIER_HASH},
  activationRequires:"Independent reviewer confirms live state equals the snapshot, writer/token/pool bindings, upgraded WASM/VKs/image, encrypted backup restore, paired close+gap liquidation+withdrawal smoke, and user-approved legacy recovery. Unpause is intentionally omitted.",
},null,2)+"\n");
