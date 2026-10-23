import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { relayLegacyExitOnce, retainConfirmedLegacyRuns } from "./legacy-exit-journal";

// Run only in the OLD VPS checkout, after a full backup and stopping all writers.
// Default mode only inspects. --prepare persists private recovery data; --execute sends closes.
const args = process.argv.slice(2);
process.umask(0o077);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const root = resolve(option("--root") ?? process.cwd());
const stagingRoot=resolve(option("--staging-root") ?? root);
const helperContractId=option("--helper");
const verifierContractId=option("--verifier");
const privatePath = resolve(option("--journal") ?? join(root, ".pnlx/legacy-pair-exit/private.json"));
const mode = args.includes("--execute") ? "execute" : args.includes("--register-proofs") ? "register" : args.includes("--prepare") ? "prepare" : "inspect";
let phase = "initialization";
let store: any;
let archiveClient:any;
function fail(code: string): never { throw new Error(`DRAIN:${code}`); }
function assert(condition: unknown, code: string): asserts condition { if (!condition) fail(code); }
const hash = (value: string | Buffer) => `0x${createHash("sha256").update(value).digest("hex")}`;
const bytes = (value: string) => value.replace(/^0x/, "");
const replacer = (_key: string, value: unknown) => typeof value === "bigint" ? { __pnlxBigInt: value.toString() } : value;
const reviver = (_key: string, value: any) => value && typeof value === "object" && typeof value.__pnlxBigInt === "string"
  ? BigInt(value.__pnlxBigInt) : value;
function save(record: any) {
  mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(privatePath), 0o700);
  const temporary = `${privatePath}.tmp`;
  const descriptor = openSync(temporary, "w", 0o600);
  try { writeFileSync(descriptor, JSON.stringify(record, replacer)); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  chmodSync(temporary, 0o600);
  renameSync(temporary, privatePath);
  const directory = openSync(dirname(privatePath), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function publicProgress(value: Record<string, unknown>) { console.log(JSON.stringify({ phase, ...value })); }

async function main() {
  process.chdir(root);
  const baseline = "63642d2";
  const baseCommit = execFileSync("git", ["rev-parse", baseline], { cwd: root, encoding: "utf8" }).trim();
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert(actualCommit === baseCommit, "old-checkout-required-do-not-pull-new-code-before-drain");
  for (const path of ["packages/crypto/src/field-merkle.ts", "circuits/position-close/src/main.nr",
    "server/src/features/account-keys/account-key-recovery.ts", "server/src/workers/onchain/onchain.service.ts"]) {
    const expected = execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root });
    assert(hash(expected) === hash(readFileSync(join(root, path))), "old-authority-or-close-code-was-modified");
  }
  if (mode !== "inspect") {
    assert(args.includes("--writers-paused"), "stop-all-api-matcher-funding-and-maker-writers-first");
    assert(args.includes("--backup-confirmed"), "full-mongo-env-runtime-and-recovery-backup-required");
  }
  const moduleCode=(path:string)=>path.replace(/[^a-zA-Z0-9]+/g,"-").toLowerCase().replace(/^-|-$/g,"");
  const mod = async(path:string)=>{try{return await import(join(root,path));}catch{fail(`old-module-import-${moduleCode(path)}`);}};
  phase="old-module-imports";
  const [{ loadEnv }, crypto, { MongoProtocolStore }, { ExecutorService },
    { createOnchainRelay }, { loadDeploymentRegistry }, { reconstructPositionOpening },makerNotes] = await Promise.all([
    mod("server/src/config/env.ts"), mod("packages/crypto/src/index.ts"), mod("server/src/shared/mongo/store.ts"),
    mod("server/src/workers/executor/executor.service.ts"), mod("server/src/workers/onchain/onchain.worker.ts"),
    mod("server/src/workers/onchain/deployment.ts"), mod("server/src/features/account-keys/account-key-recovery.ts"),
    mod("server/src/shared/maker-note-store.ts"),
  ]);
  const fresh=async(path:string)=>{try{return await import(join(stagingRoot,path));}catch{fail(`staging-module-import-${moduleCode(path)}`);}};
  phase="staging-module-imports";
  let mongodbModulePath:string;
  try{mongodbModulePath=Bun.resolveSync("mongodb",join(root,"server/src"));}catch{fail("old-mongodb-package-resolution-failed");}
  const [{RelayerService},proofTools,freshCrypto,{MongoClient}]=await Promise.all([
    fresh("server/src/workers/relayer/relayer.service.ts"),fresh("scripts/proof/legacy-position-close-pair.ts"),
    fresh("packages/crypto/src/index.ts"),import(mongodbModulePath).catch(()=>fail("old-mongodb-package-import-failed"))]);
  phase="configuration";
  const env = loadEnv();
  assert(env.stellarNetwork === "testnet" && env.stellarOnchainRelay && env.stellarRelayerMode === "stellar-cli" &&
    env.mongodbUri && env.collateralTokenContract, "testnet-custody-and-mongo-configuration-required");
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  const pool = deployment.contracts["shielded-pool"];
  const positionState = deployment.contracts["position-state"];
  assert(pool && positionState && deployment.contracts["position-close"], "deployment-bindings-unavailable");
  const deploymentFingerprint = hash(readFileSync(resolve(root, env.stellarDeploymentFile)));
  phase="mongo-state";
  store = await MongoProtocolStore.connect({ uri: env.mongodbUri, database: env.mongodbDatabase,
    collection: env.mongodbCollection, documentId: env.stellarNetwork });
  const executor = new ExecutorService({}, store);
  phase="chain-state-inspection";

  const commandTimeout = Number.isFinite(env.stellarCommandTimeoutMs) ? Math.min(env.stellarCommandTimeoutMs, 120_000) : 120_000;
  const oneSendRunner = (command: string, commandArgs: string[]) => {
    const sendAt = commandArgs.indexOf("--send");
    const financialSend = (sendAt >= 0 && commandArgs[sendAt + 1] === "yes") || (commandArgs[0] === "tx" && commandArgs[1] === "send");
    const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout: commandTimeout,
      killSignal: "SIGKILL", maxBuffer: 600_000 });
    // Throw before V1 runCommandWithRetry can rebuild or resend a financial invocation.
    if (financialSend && (result.error || result.status !== 0)) fail("financial-command-outcome-unknown-no-automatic-retry");
    if (financialSend) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_500);
    return { status: result.status, stdout: result.stdout ?? "",
      stderr: financialSend ? result.stderr ?? "" : result.status === 0 ? "" : result.stderr ?? "" };
  };
  const relayer = new RelayerService({ commandTimeoutMs: commandTimeout,
    mode: "stellar-cli", network: env.stellarNetwork, networkPassphrase: env.stellarNetworkPassphrase,
    rpcUrl: env.stellarRpcUrl, source: env.stellarSource },oneSendRunner);
  const onchain = createOnchainRelay(relayer, { enabled: true, deployment,
    resolveProofArtifact: (proof: any) => executor.artifactFor(proof) });
  const scalar = async (contractId: string, method: string, callArgs: string[] = []) => {
    const result = await relayer.readAsync({ kind: "contract-invoke", payload: { contractId,
      functionName: method, args: callArgs, send: "no" } });
    return String(result.stdout ?? result.output).trim().replace(/^"|"$/g, "");
  };
  const bool = async (contractId: string, method: string, callArgs: string[]) => {
    const result = await scalar(contractId, method, callArgs);
    assert(result === "true" || result === "false", "chain-boolean-unavailable");
    return result === "true";
  };
  const number = async (contractId: string, method: string, callArgs: string[]) => {
    const result = await scalar(contractId, method, callArgs);
    assert(/^-?\d+$/.test(result), "chain-integer-unavailable");
    return BigInt(result);
  };
  const txStatus = async (txHash: string) => {
    const response = await fetch(env.stellarRpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash: bytes(txHash) } }),
      signal: AbortSignal.timeout(15_000) });
    assert(response.ok, "transaction-rpc-unavailable");
    const body = await response.json() as any;
    assert(!body.error && ["SUCCESS", "FAILED", "NOT_FOUND"].includes(body.result?.status), "transaction-status-unknown");
    return body.result.status as string;
  };
  const confirmTx = async (txHash: string) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await txStatus(txHash);
      if (result === "SUCCESS") return;
      assert(result !== "FAILED", "financial-transaction-failed-preserve-journal");
      if (attempt < 7) await new Promise((done) => setTimeout(done, 2_000));
    }
    fail("financial-receipt-not-confirmed-preserve-journal-no-resubmission");
  };
  const marketArgs = (marketId: string) => ["--market_id", bytes(crypto.hashFields("market-id", [marketId]))];
  const ownerAddresses = new Map<string, string>();
  const addStoredAddress = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim().toUpperCase();
    if (/^G[A-Z2-7]{55}$/.test(normalized)) ownerAddresses.set(crypto.ownerCommitment(normalized).toLowerCase(), normalized);
  };
  for (const address of [env.makerWalletAddress, ...(option("--owners") ?? "").split(",")].filter(Boolean)) {
    const normalized = String(address).trim().toUpperCase();
    assert(/^G[A-Z2-7]{55}$/.test(normalized), "provide-real-owner-wallet-addresses");
    ownerAddresses.set(crypto.ownerCommitment(normalized).toLowerCase(), normalized);
  }
  // V1 account keys normally contain only commitments, not wallet addresses.
  // Resolve known historical identities and accept them only by exact owner hash.
  const notes = await makerNotes.readMakerNotes();
  for (const pending of store.pendingAssetDeposits.values()) addStoredAddress(pending.from);
  for (const note of notes) addStoredAddress(note.walletAddress);
  for (const key of store.accountEncryptionKeys.values()) {
    for (const field of ["walletAddress", "address", "owner"]) addStoredAddress(key[field]);
  }
  const live = [...store.positionLifecycle.values()].filter((position: any) => position.status === "open") as any[];
  const previous = existsSync(privatePath) ? JSON.parse(readFileSync(privatePath, "utf8"), reviver) : undefined;
  const refreshing=mode==="prepare" && args.includes("--refresh-unsubmitted");
  if(mode==="inspect" || (mode==="prepare" && !refreshing))assert(live.length===6,"expected-exactly-six-owned-open-positions");
  if(mode!=="inspect")assert(/^C[A-Z2-7]{55}$/.test(helperContractId??"") && /^C[A-Z2-7]{55}$/.test(verifierContractId??""),"explicit-legacy-helper-and-verifier-required");
  if (mode === "execute" || mode === "register") assert(previous?.version === 2 && previous.baseCommit === baseCommit &&
    previous.deploymentFingerprint === deploymentFingerprint && previous.helperContractId===helperContractId &&
    previous.verifierContractId===verifierContractId && previous.positions.length === 6, "prepared-journal-required");
  const positions = mode === "execute" || mode==="register" || refreshing ? previous?.positions.map((item: any) => store.positionLifecycle.get(item.positionCommitment)) : live;
  assert(Array.isArray(positions) && positions.length===6 && positions.every((position: any) => position && ownerAddresses.has(position.ownerCommitment.toLowerCase())), "all-six-owner-wallet-addresses-must-be-explicitly-identified");
  publicProgress({ resolvedOwners: [...new Set(positions.map((position: any) => ownerAddresses.get(position.ownerCommitment.toLowerCase())))] });
  if ((mode !== "execute" && mode!=="register") || !(previous.runs ?? []).some((run: any) => run?.attempted && !run.completed)) {
    assert(await onchain.positionRootAsync() === store.positionMembershipRoot(), "position-tree-out-of-sync-reconcile-before-drain");
  }
  phase = "pending-state-inspection";
  const pendingDeposits = [];
  for (const pending of store.pendingAssetDeposits.values()) {
    if (pending.finalizedAt) continue;
    const known = await bool(pool, "has_commitment", ["--commitment", bytes(pending.commitment)]);
    const txHash = pending.txHash ?? pending.preparedTxHash;
    pendingDeposits.push({ commitment: pending.commitment, recordedOnchain: known,
      transactionStatus: txHash ? await txStatus(txHash) : "NO_RECORDED_HASH", finalizedLocally: false });
  }
  const pendingBatches = [];
  for (const run of store.batchExecutionRuns.values()) {
    if (!["running", "failed"].includes(run.status) || !run.settlementDigest ||
        [...store.settlements.values()].some((item: any) => item.settlementDigest === run.settlementDigest)) continue;
    const settled = await bool(deployment.contracts["batch-settlement"], "is_settled_digest", [
      "--batch_id", bytes(crypto.hashFields("batch-id", [run.batchId])), ...marketArgs(run.marketId),
      "--settlement_digest", bytes(run.settlementDigest),
    ]);
    let activeIntents = 0;
    for (const id of run.intentCommitments ?? []) if (await bool(deployment.contracts["intent-registry"], "is_active_intent", ["--intent_commitment", bytes(id)])) activeIntents++;
    pendingBatches.push({ runId: run.runId, settledOnchain: settled, activeIntents });
  }
  publicProgress({ pendingDeposits, pendingBatches, financiallyUnresolved: pendingBatches.some((item) => item.settledOnchain || item.activeIntents > 0) });
  assert(!pendingBatches.some((item) => item.settledOnchain || item.activeIntents > 0), "resolve-exact-old-batch-and-cancel-its-active-intents-before-drain");
  const pairs: any[] = [];
  const visited = new Set<string>();
  for (const position of positions) {
    if (visited.has(position.positionCommitment)) continue;
    const settlement = [...store.settlements.values()].find((item: any) => item.settlementDigest === position.settlementDigest) as any;
    const index = settlement?.newCommitments.indexOf(position.positionCommitment) ?? -1;
    assert(index >= 0 && settlement.newCommitments.length % 2 === 0, "legacy-pair-membership-unavailable");
    const other = store.positionLifecycle.get(settlement.newCommitments[index ^ 1]);
    assert(other && positions.some((item: any) => item.positionCommitment === other.positionCommitment), "counterparty-outside-six-owned-positions");
    const ordered = [position, other].sort((a, b) => settlement.newCommitments.indexOf(a.positionCommitment) - settlement.newCommitments.indexOf(b.positionCommitment));
    const legs = ordered.map((item) => {
      const opening = reconstructPositionOpening(store, item);
      assert(opening, "legacy-source-payload-cannot-reconstruct-exact-position");
      const fillIndex = settlement.newCommitments.indexOf(item.positionCommitment);
      const rho = `${item.sourceIntentCommitment}:position:${fillIndex}`;
      const secrets = { marketDigest: crypto.digestToFieldHex(`market:${item.marketId}`),
        ownerDigest: crypto.digestToFieldHex(`owner:${item.ownerCommitment}`),
        rhoDigest: crypto.digestToFieldHex(`rho:${rho}`),
        blinding: crypto.digestToFieldHex(`blinding:${item.sourceIntentCommitment}:blinding:${fillIndex}`),
        spendSecretDigest: crypto.digestToFieldHex(`spend:${item.ownerCommitment}:${rho}`) };
      assert(crypto.circuitPositionCommitment({ ...opening, ...secrets }) === item.positionCommitment &&
        crypto.circuitPositionNullifier(secrets) === item.positionNullifier, "legacy-opening-does-not-match-funded-chain-position");
      visited.add(item.positionCommitment);
      return { positionCommitment: item.positionCommitment, positionNullifier: item.positionNullifier,
        ownerCommitment: item.ownerCommitment, walletAddress: ownerAddresses.get(item.ownerCommitment.toLowerCase()), opening, secrets };
    });
    assert(legs[0].opening.side !== legs[1].opening.side && legs[0].opening.size === legs[1].opening.size &&
      legs[0].opening.entryPrice === legs[1].opening.entryPrice && legs[0].opening.fundingIndex === legs[1].opening.fundingIndex,
      "legacy-pair-economics-mismatch");
    pairs.push({ marketId: position.marketId, legs });
  }
  assert(pairs.length === 3, "expected-exactly-three-backed-pairs");
  const economics = (pair: any, mark: bigint, funding: bigint) => pair.legs.map((leg: any) => {
    const p = leg.opening;
    const pnl = p.size * (p.side === "long" ? mark - p.entryPrice : p.entryPrice - mark) / 100_000_000n;
    const fundingPayment = p.size * (funding - p.fundingIndex) / 100_000_000n * (p.side === "long" ? 1n : -1n);
    return { payout: p.margin + pnl - fundingPayment, fundingPayment };
  });
  const pairInspection = [];
  for (const [index, pair] of (mode === "execute" || mode==="register" ? [] : pairs).entries()) {
    const mark = (await onchain.marketPriceSnapshotAsync(pair.marketId)).price;
    const funding = await number(deployment.contracts.market, "funding_index", marketArgs(pair.marketId));
    const payouts = economics(pair, mark, funding);
    const collateral = pair.legs[0].opening.margin + pair.legs[1].opening.margin;
    const positiveEquity = payouts.reduce((sum: bigint, item: any) => sum + (item.payout > 0n ? item.payout : 0n), 0n);
    const shortfall = payouts.reduce((sum: bigint, item: any) => sum + (item.payout < 0n ? -BigInt(item.payout) : 0n), 0n);
    assert(payouts[0].payout + payouts[1].payout === collateral, "pair-collateral-not-conserved");
    pairInspection.push({ pair: index + 1, marketId: pair.marketId,
      pairCollateral: collateral.toString(), combinedSignedEquity: collateral.toString(),
      positiveEquitySum: positiveEquity.toString(), unfundedProfit: shortfall.toString(),
      insolventLegs: payouts.filter((item: any) => item.payout < 0n).length });
  }
  const assetDigest=await onchain.tokenDigest(env.collateralTokenContract);
  assert(!env.collateralTokenDigest || env.collateralTokenDigest===assetDigest,"configured-collateral-digest-mismatch");
  const allowedPairs=pairs.map(pair=>({market_id:bytes(crypto.hashFields("market-id",[pair.marketId])),asset_digest:bytes(assetDigest),
    position_commitments:pair.legs.map((leg:any)=>bytes(leg.positionCommitment)),position_nullifiers:pair.legs.map((leg:any)=>bytes(leg.positionNullifier))}));
  if(mode==="inspect") { publicProgress({mode,openPositions:live.length,pairs:pairInspection,allowedPairs,
    ownersWithoutEncryptionKeys:[...new Set(positions.filter((position:any)=>!store.accountEncryptionKey(position.ownerCommitment)?.publicKey)
      .map((position:any)=>ownerAddresses.get(position.ownerCommitment.toLowerCase())))],writes:false});return; }
  const json=async(contract:string,method:string,callArgs:string[]=[])=>{const value=await scalar(contract,method,callArgs);try{return JSON.parse(value);}catch{fail("invalid-chain-structured-response");}};
  const normalized=(value:unknown)=>String(value).replace(/^0x/,"").toLowerCase();
  const equalHex=(a:unknown,b:unknown)=>normalized(a)===normalized(b);
  const config=await json(helperContractId!,"configuration");
  assert(config.governance===deployment.contracts.governance && config.proof_ledger===deployment.contracts["proof-ledger"] &&
    config.market_contract===deployment.contracts.market && config.position_state===positionState && config.secure_pool===pool &&
    equalHex(config.circuit_id,crypto.hashFields("circuit-id",[proofTools.LEGACY_PAIR_CIRCUIT])),"helper-configuration-mismatch");
  const allowlist=await json(helperContractId!,"allowed_pairs");
  assert(Array.isArray(allowlist) && allowlist.length===3 && allowedPairs.every((pair:any,i:number)=>
    equalHex(pair.market_id,allowlist[i].market_id) && equalHex(pair.asset_digest,allowlist[i].asset_digest) &&
    [0,1].every(j=>equalHex(pair.position_commitments[j],allowlist[i].position_commitments[j]) &&
      equalHex(pair.position_nullifiers[j],allowlist[i].position_nullifiers[j]))),"immutable-helper-allowlist-mismatch");
  const marketConfig=async(marketId:string)=>{
    const value=await json(deployment.contracts.market,"get",marketArgs(marketId));
    assert(value.active===true && /^-?\d+$/.test(String(value.funding_index)) && /^\d+$/.test(String(value.maintenance_rate)),"market-configuration-unavailable");
    return {funding:BigInt(value.funding_index),maintenance:BigInt(value.maintenance_rate)};
  };
  if(mode==="prepare") {
    for(const position of positions)assert(store.accountEncryptionKey(position.ownerCommitment)?.publicKey ||
      ownerAddresses.get(position.ownerCommitment.toLowerCase())===env.makerWalletAddress?.trim().toUpperCase(),
      "trader-account-encryption-key-required-before-legacy-close");
    if(previous)assert(args.includes("--refresh-unsubmitted") && previous.version===2 &&
      previous.baseCommit===baseCommit && previous.deploymentFingerprint===deploymentFingerprint &&
      previous.helperContractId===helperContractId && previous.verifierContractId===verifierContractId &&
      !previous.runs.some((run:any)=>run?.attempted && !run.completed),"uncertain-exit-must-be-reconciled-before-unsubmitted-proof-refresh");
    if(previous)for(const run of previous.runs.filter((run:any)=>run?.completed))assert(run.attempted && run.txHash &&
      run.pair.positions.every((record:any)=>store.positionCloses.has(record.closeCommitment) &&
        store.positionLifecycle.get(record.positionCommitment)?.status==="closed"),"completed-exit-mirror-must-be-reconciled-before-refresh");
    const journal:any={version:2,baseCommit,deploymentFingerprint,helperContractId,verifierContractId,createdAt:Date.now(),
      positions:positions.map((item:any)=>({positionCommitment:item.positionCommitment})),pairs,pendingDeposits,pendingBatches,
      runs:previous?retainConfirmedLegacyRuns(previous.runs):[],
      supersededRuns:previous?[...(previous.supersededRuns??[]),...previous.runs.filter((run:any)=>run && !run.completed)]:[]};
    save(journal);
    const predicted=[...store.positionCommitments];
    for(const [index,pair] of pairs.entries()) {
      if(journal.runs[index]?.completed)continue;
      phase=`prepare-pair-${index+1}`;
      const mark=(await onchain.marketPriceSnapshotAsync(pair.marketId)).price;
      const market=await marketConfig(pair.marketId);
      const payouts=economics(pair,mark,market.funding);
      const collateral=pair.legs[0].opening.margin+pair.legs[1].opening.margin;
      const rootBefore=freshCrypto.positionMerkleRoot(predicted);
      const outputs:any[]=[],witnesses:any[]=[];
      for(const [legIndex,leg] of pair.legs.entries()) {
        const freshField=(label:string)=>crypto.digestToFieldHex(`legacy-exit:${label}:${randomBytes(32).toString("hex")}`);
        const closeCommitment=freshField("close"),rhoDigest=freshField("output-rho"),blinding=freshField("output-blinding"),spendSecretDigest=freshField("output-spend");
        const newPositionRhoDigest=freshField("terminal-rho"),newPositionBlinding=freshField("terminal-blinding");
        const equity=payouts[legIndex].payout,amount=equity<0n?0n:equity>collateral?collateral:equity;
        const output:any={amount:amount.toString(),assetDigest,rhoDigest,blinding,spendSecretDigest,ownerDigest:leg.secrets.ownerDigest,
          ownerCommitment:leg.ownerCommitment,walletAddress:leg.walletAddress,noteFormat:"secure",
          commitment:crypto.secureMarginCommitment({amount,assetDigest,rhoDigest,blinding,spendSecretDigest,ownerDigest:leg.secrets.ownerDigest}),
          noteNullifier:crypto.secureMarginNullifier({rhoDigest,spendSecretDigest}),closePositionCommitment:leg.positionCommitment,
          closeCommitment,createdAt:Date.now(),token:env.collateralTokenContract,shieldedPool:pool,source:env.stellarSource};
        if(leg.walletAddress===env.makerWalletAddress?.trim().toUpperCase()) {
          const source=notes.filter((note:any)=>note.lockedByIntentCommitment===store.positionLifecycle.get(leg.positionCommitment).sourceIntentCommitment && note.vaultAllocationId);
          assert(source.length===1,"maker-allocation-source-missing-or-ambiguous");
          Object.assign(output,{vaultAllocationId:source[0].vaultAllocationId,vaultParentCommitment:source[0].commitment,source:source[0].source});
        }
        const membership=freshCrypto.positionMerkleProof(predicted,leg.positionCommitment);
        const newPositionCommitment=freshCrypto.circuitPositionCommitment({...leg.opening,...leg.secrets,
          marketDigest:freshCrypto.fieldHex(BigInt(crypto.hashFields("market-id",[pair.marketId]))),size:0n,margin:0n,
          rhoDigest:newPositionRhoDigest,blinding:newPositionBlinding});
        witnesses.push({...leg.opening,...leg.secrets,marketId:pair.marketId,positionCommitment:leg.positionCommitment,
          positionNullifier:leg.positionNullifier,positionRoot:rootBefore,markPrice:mark,currentFundingIndex:market.funding,
          closeCommitment,newPositionRhoDigest,newPositionBlinding,newPositionCommitment,marginOutputAmount:amount,
          marginOutputCommitment:output.commitment,marginOutputAssetDigest:assetDigest,marginOutputRhoDigest:rhoDigest,
          marginOutputBlinding:blinding,marginOutputSpendSecretDigest:spendSecretDigest,pathIndices:membership.indices,pathSiblings:membership.siblings});
        outputs.push(output);
      }
      const prepared=await proofTools.proveLegacyPair(stagingRoot,witnesses,market.maintenance);
      const expectedVk=await scalar(deployment.contracts.governance,"verifier",["--circuit_id",bytes(prepared.pair.proof.circuitKey)]);
      assert(equalHex(expectedVk,prepared.pair.proof.verifierHash),"legacy-proof-verifier-not-configured");
      const run={...prepared,outputs,mark,funding:market.funding,maintenance:market.maintenance,attempted:false,completed:false};
      journal.runs[index]=run;save(journal);
      predicted.push(...prepared.pair.positions.map((record:any)=>record.newPositionCommitment));
      publicProgress({prepared:true,pair:index+1,transactionsSubmitted:0});
    }
    publicProgress({mode,preparedPairs:journal.runs.length,journal:privatePath,transactionsSubmitted:0});return;
  }
  const journal=previous;
  assert(journal.runs.length===3 && journal.runs.every(Boolean),"all-three-pair-proofs-must-be-prepared-first");
  const proofArgument=(proof:any)=>JSON.stringify({circuit_hash:bytes(proof.circuitHash),circuit_id:bytes(proof.circuitKey),
    proof_digest:bytes(proof.proofDigest),public_input_hash:bytes(proof.publicInputHash),verifier_hash:bytes(proof.verifierHash)});
  const hasProof=async(proof:any)=>bool(deployment.contracts["proof-ledger"],"has_proof",[
    "--circuit_id",bytes(proof.circuitKey),"--verifier_hash",bytes(proof.verifierHash),
    "--public_input_hash",bytes(proof.publicInputHash),"--proof_digest",bytes(proof.proofDigest)]);
  if(mode==="register") {
    assert(!await bool(deployment.contracts.governance,"paused",[]),"proof-registration-requires-unpaused-governance");
    for(const [index,run] of journal.runs.entries()) {
      phase=`register-pair-${index+1}`;
      if(await hasProof(run.pair.proof)){run.registered=true;save(journal);continue;}
      if(run.registrationAttempted) { assert(run.registrationTxHash,"registration-hash-missing-preserve-journal");
        await confirmTx(run.registrationTxHash);assert(await hasProof(run.pair.proof),"confirmed-proof-registration-missing"); }
      else {
        await relayer.relayJournaled({kind:"contract-invoke",payload:{contractId:verifierContractId,
          functionName:"verify_and_record",args:["--public_inputs-file-path",run.artifact.publicInputsPath,
            "--proof_bytes-file-path",run.artifact.proofPath,"--public_input_hash",bytes(run.pair.proof.publicInputHash),
            "--proof_digest",bytes(run.pair.proof.proofDigest)],send:"yes"}},async(prepared:any)=>{
              run.registrationAttempted=true;run.registrationTxHash=prepared.txHash;run.registrationXdr=prepared.xdr;save(journal);
            });
        await confirmTx(run.registrationTxHash);assert(await hasProof(run.pair.proof),"confirmed-proof-registration-missing");
      }
      run.registered=true;save(journal);publicProgress({registered:true,pair:index+1});
    }
    publicProgress({registeredProofs:3,financialExitsSubmitted:0,next:"pause-governance-then-execute"});return;
  }
  assert(await bool(deployment.contracts.governance,"paused",[]),"governance-must-be-paused-for-legacy-exit");
  archiveClient=new MongoClient(env.mongodbUri);await archiveClient.connect();
  const archives=archiveClient.db(env.mongodbDatabase||"pnlx").collection(`${env.mongodbCollection||"protocol_state"}_legacy_exit_outputs`);
  const [{createLegacyExitAccountEvent},{encryptAccountEventPayload}]=await Promise.all([
    fresh("server/src/features/notes/legacy-exit-recovery.ts"),fresh("server/src/shared/protocol/account-event-encryption.ts")]);
  for(const [index,run] of journal.runs.entries()) {
    phase=`exit-pair-${index+1}`;
    const pair=run.pair;
    assert(await hasProof(pair.proof),"exact-legacy-pair-proof-not-registered");
    assert(run.outputs.length===2 && pair.positions.length===2,"prepared-pair-record-count-mismatch");
    for(const [legIndex,record] of pair.positions.entries()) {
      const output=run.outputs[legIndex],source=store.positionLifecycle.get(record.positionCommitment);
      const note={amount:BigInt(output.amount),assetDigest:output.assetDigest,ownerDigest:output.ownerDigest,
        rhoDigest:output.rhoDigest,blinding:output.blinding,spendSecretDigest:output.spendSecretDigest};
      assert(source && output.ownerCommitment===source.ownerCommitment &&
        output.ownerDigest===crypto.digestToFieldHex(`owner:${source.ownerCommitment}`) &&
        output.closeCommitment===record.closeCommitment && output.closePositionCommitment===record.positionCommitment &&
        output.commitment===record.marginOutputCommitment && output.assetDigest===pair.assetDigest &&
        crypto.secureMarginCommitment(note)===output.commitment && crypto.secureMarginNullifier(note)===output.noteNullifier,
        "prepared-refund-opening-does-not-match-exact-close");
    }
    if(!run.attempted) {
      const market=await marketConfig(pair.marketId);
      assert((await onchain.marketPriceSnapshotAsync(pair.marketId)).price===run.mark && market.funding===run.funding &&
        market.maintenance===run.maintenance,"market-moved-preserve-prepared-proof-do-not-send");
      assert(await onchain.positionRootAsync()===pair.positionRoot && store.positionMembershipRoot()===pair.positionRoot,"position-root-changed-before-exit");
      for(const output of run.outputs) {
        const publicKey=store.accountEncryptionKey(output.ownerCommitment)?.publicKey;
        assert(publicKey || output.vaultAllocationId,"trader-account-encryption-key-required-before-legacy-close");
        if(publicKey)encryptAccountEventPayload({kind:"legacy-refund-key-check"},publicKey);
      }
      for(const output of run.outputs)if(output.vaultAllocationId) {
        const existing=(await makerNotes.readMakerNotes()).find((note:any)=>note.commitment===output.commitment);
        if(!existing)await makerNotes.insertPendingMakerNote(output);
      }
      const invokeArgs=JSON.stringify({market_id:bytes(crypto.hashFields("market-id",[pair.marketId])),mark_price:pair.markPrice.toString(),
        liquidation:false,position_root:bytes(pair.positionRoot),position_commitments:pair.positions.map((p:any)=>bytes(p.positionCommitment)),
        position_nullifiers:pair.positions.map((p:any)=>bytes(p.positionNullifier)),close_commitments:pair.positions.map((p:any)=>bytes(p.closeCommitment)),
        new_position_commitments:pair.positions.map((p:any)=>bytes(p.newPositionCommitment)),margin_output_commitments:pair.positions.map((p:any)=>bytes(p.marginOutputCommitment))});
      await relayLegacyExitOnce(run,(beforeSubmit)=>relayer.relayJournaled({kind:"position-close",payload:{
        contractId:helperContractId,functionName:"exit_pair",args:["--args",invokeArgs,"--proof",proofArgument(pair.proof)],send:"yes"}},beforeSubmit),
        ()=>save(journal));
    }
    assert(run.txHash,"exact-signed-transaction-hash-unavailable-no-resubmission");await confirmTx(run.txHash);
    const receipt=await json(helperContractId!,"receipt",["--first_position",bytes(pair.positions[0].positionCommitment)]);
    assert(receipt && Number(receipt.appended?.count)===2 && equalHex(receipt.proof_digest,pair.proof.proofDigest) &&
      equalHex(receipt.market_id,crypto.hashFields("market-id",[pair.marketId])),"confirmed-helper-receipt-missing-or-wrong");
    assert(Number.isSafeInteger(receipt.ledger) && receipt.ledger>0 &&
      equalHex(await relayer.findContractEventTransaction(helperContractId!,receipt.ledger,pair.positions[0].closeCommitment),run.txHash),
      "successful-transaction-does-not-match-helper-receipt-event");
    for(const [legIndex,record] of pair.positions.entries()) {
      for(const [key,value] of [["position_commitments",record.positionCommitment],["position_nullifiers",record.positionNullifier],
        ["close_commitments",record.closeCommitment],["new_position_commitments",record.newPositionCommitment],["margin_output_commitments",record.marginOutputCommitment]])
        assert(equalHex(receipt[key]?.[legIndex],value),"confirmed-helper-output-binding-mismatch");
      assert(await bool(positionState,"is_spent",["--position_nullifier",bytes(record.positionNullifier)]) &&
        await bool(positionState,"is_commitment_spent",["--position_commitment",bytes(record.positionCommitment)]) &&
        await bool(pool,"has_commitment",["--commitment",bytes(record.marginOutputCommitment)]),"confirmed-exit-financial-state-mismatch");
    }
    const applied=pair.positions.map((record:any)=>store.positionCloses.has(record.closeCommitment));
    assert(applied.every(Boolean)||applied.every((value:boolean)=>!value),"partial-local-close-reconciliation-required");
    const records=pair.positions.map((record:any)=>({...record,settlementTxHash:run.txHash}));
    if(!applied.every(Boolean)) {
      assert(Number(receipt.appended.first_index)===store.positionCommitments.size &&
        equalHex(freshCrypto.positionMerkleRoot([...store.positionCommitments,...records.map((r:any)=>r.newPositionCommitment)]),receipt.appended.root) &&
        equalHex(receipt.appended.root,await onchain.positionRootAsync()),"confirmed-authoritative-append-index-or-root-mismatch");
      for(const record of records)store.recordProof(record.proof);
      store.addPairedPositionCloses(records[0],records[1],false);
      for(const [legIndex,record] of records.entries())store.positionCloses.set(record.closeCommitment,{...record,
        outputPositionIndex:Number(receipt.appended.first_index)+legIndex,outputPositionRoot:`0x${normalized(receipt.appended.root)}`});
      // V1's mirror writes an intermediate root; retain the actual atomic append receipt instead.
      store.recordProof(pair.proof);await store.flush();
    }
    for(const [legIndex,record] of records.entries()) {
      const position=store.positionLifecycle.get(record.positionCommitment),output=run.outputs[legIndex];
      const archive={_id:`${helperContractId}:${record.closeCommitment}:${legIndex}`,ownerCommitment:position.ownerCommitment,createdAt:output.createdAt,
        legacyExit:{helperContractId,transactionHash:run.txHash,closeCommitment:record.closeCommitment,outputIndex:legIndex},
        positionClose:record,closeOutputNote:output,confirmed:true};
      const old=await archives.findOne({_id:archive._id});
      if(old)assert(old.legacyExit?.transactionHash===run.txHash && old.closeOutputNote?.commitment===output.commitment,"private-refund-archive-conflict");
      else await archives.insertOne(JSON.parse(JSON.stringify(archive,(_key,value)=>typeof value==="bigint"?value.toString():value)));
      const publicKey=store.accountEncryptionKey(position.ownerCommitment)?.publicKey;
      if(publicKey)store.addAccountEvent(createLegacyExitAccountEvent(archive,publicKey));
      if(output.vaultAllocationId) {
        const makerCollection=archiveClient.db(env.mongodbDatabase||"pnlx").collection("maker_notes");
        const binding=JSON.stringify(archive.legacyExit);
        const makerFilter={_id:`${env.stellarNetwork}:${output.commitment}`,namespace:env.stellarNetwork,
          commitment:output.commitment,closePositionCommitment:record.positionCommitment,
          closeCommitment:record.closeCommitment,ownerDigest:output.ownerDigest};
        const annotated=await makerCollection.updateOne({...makerFilter,$or:[{legacyExit:{$exists:false}},{legacyExit:binding}]},
          {$set:{legacyExit:binding,updatedAt:Date.now()}});
        assert(annotated.matchedCount===1,"confirmed-maker-legacy-receipt-binding-conflict");
        const saved=(await makerNotes.readMakerNotes()).find((note:any)=>note.commitment===output.commitment);
        if(saved?.status==="pending")await makerNotes.finalizePendingMakerCloseOutput(output.commitment,run.txHash);
        else assert(saved?.closeTxHash===run.txHash,"maker-refund-receipt-mismatch");
      }
    }
    await store.flush();run.completed=true;save(journal);
    publicProgress({confirmed:true,pair:index+1,txHash:run.txHash,outputsRetainedPrivately:2});
  }
  phase="complete";
  assert([...store.positionLifecycle.values()].every((position:any)=>position.status!=="open"),"unexpected-open-positions-remain");
  await store.flush();publicProgress({closedPositions:6,confirmedPairs:3,journal:privatePath,legacyRefundsRecoverable:true,automaticUpgrade:false});
}
try { await main(); }
catch(error) {const code=error instanceof Error && /^DRAIN:[a-z0-9-]+$/.test(error.message)?error.message.slice(6):"external-operation-failed-preserve-private-journal";
 console.error(JSON.stringify({phase,stopped:true,code,financialRetryAllowed:false}));process.exitCode=1;}
finally {if(store)await store.close().catch(()=>{process.exitCode=1;});if(archiveClient)await archiveClient.close().catch(()=>{process.exitCode=1;});}
