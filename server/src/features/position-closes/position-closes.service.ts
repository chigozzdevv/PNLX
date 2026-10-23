import { contractPublicInputHash, publicField, publicI128, publicU128 } from "@pnlx/proof-system";
import type { ServerEnv } from "@/config/env";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import { assertAuthenticatedOwnerCommitment } from "@/shared/http/auth-context";
import { assertFundingPayment } from "@/shared/protocol/funding";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import { createPositionCloseAccountEvent } from "@/shared/protocol/account-event-outcomes";
import { PRICE_SCALE } from "@pnlx/market-math";
import type { Hex, MarketConfig, PositionCloseWitness, PositionLifecycleRecord } from "@pnlx/protocol-types";
import { ownerCommitment, hashFields, secureMarginNullifier } from "@pnlx/crypto";
import { hostedPositionCloseWitness, pairedPosition, positionPayout } from "@/features/position-closes/paired-position-witness";
import type { PendingPairedClose } from "@/shared/protocol/paired-close-journal";
import { assertPositionMutationReady, withPositionMutation } from "@/shared/protocol/position-mutation";
import { vaultMakerPairForTrader } from "@/features/position-closes/vault-maker-pair";
import {
  finalizePendingMakerCloseOutput,
  deleteUnsettledPendingMakerCloseOutput,
  insertPendingMakerNote,
  readMakerNotes,
  type StoredMakerNoteRecord,
} from "@/shared/maker-note-store";
import { readVaultMakerAllocations } from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import type {
  CreatePositionCloseInput,
  PositionCloseContextInput,
  PositionCloseContextResult,
  CreatePositionCloseResult,
  CreateProvenPositionCloseInput,
} from "@/features/position-closes/position-closes.model";

const pairLocks = new WeakMap<object, Set<string>>();

export class PositionClosesService {
  private recoveryCursor=0;
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly onchain?: OnchainRelayService,
    private readonly env: Pick<ServerEnv, "settlementsOnchainRequired"> &
      Partial<Pick<ServerEnv, "authRequired" | "makerWalletAddress" | "mongodbUri" |
        "collateralTokenContract" | "stellarDeploymentFile">> = {
      settlementsOnchainRequired: false,
    },
  ) {}

  context(input: PositionCloseContextInput, authenticated?: string): PositionCloseContextResult {
    assertAuthenticatedOwnerCommitment(authenticated, input.ownerCommitment, "ownerCommitment");
    const position = this.executor.store.positionsFor(input.ownerCommitment).find(
      (candidate) => candidate.positionCommitment === input.positionCommitment,
    );
    if (!position) throw new Error("position not found");
    if (position.status !== "open") throw new Error("position is not open");

    const membershipProof = this.executor.store.positionMembershipProof(input.positionCommitment);
    const positionRoot = this.executor.store.positionMembershipRoot();
    if (membershipProof.root !== positionRoot) throw new Error("position root is not current");
    const market = marketConfig(this.executor, position.marketId);
    const markPrice = this.currentMarkPrice(market);
    const currentFundingIndex=this.currentFundingIndex(market);

    return {
      payoutAmount: positionPayout(this.executor.store, position, markPrice,currentFundingIndex).toString(),
      market: {
        fundingIndex: currentFundingIndex.toString(),
        marketId: market.marketId,
        markPrice: markPrice.toString(),
      },
      membershipProof,
      positionRoot,
    };
  }

  async createManualPaired(input: PositionCloseWitness, authenticated?: string): Promise<CreatePositionCloseResult> {
    this.assertCloseOwner(input, authenticated);
    return this.closePair(input, false, false);
  }

  async createConditionalPaired(input: PositionCloseWitness, authenticated?: string): Promise<CreatePositionCloseResult> {
    this.assertCloseOwner(input,authenticated);
    const trigger=this.executor.store.conditionalCloses.get(input.closeCommitment);
    if (!trigger || trigger.marketId!==input.marketId || trigger.positionNullifier!==input.positionNullifier) {
      throw new Error("conditional close not triggered");
    }
    return this.closePair(input,true,false);
  }

  async closeHosted(position: PositionLifecycleRecord, closeCommitment: Hex, conditional = false,
    liquidation = false): Promise<CreatePositionCloseResult> {
    const market = marketConfig(this.executor, position.marketId);
    const source = this.executor.store.intents.get(position.sourceIntentCommitment);
    const assetDigest = source?.assetDigest ?? [...this.executor.store.intents.values()]
      .find((record) => record.marketId === position.marketId)?.assetDigest;
    if (!assetDigest) throw new Error("position collateral asset is unavailable");
    const [markPrice, currentFundingIndex] = await Promise.all([
      this.currentMarkPriceAsync(market), this.currentFundingIndexAsync(market),
    ]);
    const prepared = hostedPositionCloseWitness({store:this.executor.store,position,
      markPrice,currentFundingIndex,
      assetDigest,closeCommitment});
    return this.closePair(prepared.witness,conditional,liquidation);
  }

  async recoverPendingPairs(): Promise<void> {
    const runs=[...this.executor.store.pendingPairedCloses.values()].filter(run=>!run.retiredReconciled);
    const count=Math.min(25,runs.length);
    let failure:unknown;
    for(let index=0;index<count;index++) {
      const run=runs[(this.recoveryCursor+index)%runs.length]!;
      const lockKey=run.pair.positions.map((record)=>record.positionCommitment).sort().join(":");
      const locks=pairLocks.get(this.executor.store) ?? new Set<string>(); pairLocks.set(this.executor.store,locks);
      if (locks.has(lockKey)) continue;
      locks.add(lockKey);
      try {
        if(run.retired)await this.observeRetiredPair(run);
        else await this.commitPairRun(run);
      } catch(error){failure??=error;} finally { locks.delete(lockKey); }
    }
    this.recoveryCursor=runs.length?(this.recoveryCursor+count)%runs.length:0;
    if(failure)throw failure;
  }

  private async closePair(input: PositionCloseWitness, conditional: boolean, liquidation: boolean): Promise<CreatePositionCloseResult> {
    const store = this.executor.store;
    const position = store.positionFor(input.positionCommitment,input.positionNullifier);
    if (!position) throw new Error("position not found");
    const counterpart = pairedPosition(store,position);
    const lockKey = [position.positionCommitment,counterpart.positionCommitment].sort().join(":");
    const locks = pairLocks.get(store) ?? new Set<string>(); pairLocks.set(store,locks);
    if (locks.has(lockKey)) throw new Error("paired position close already in progress");
    locks.add(lockKey);
    try {
      const pending = [...store.pendingPairedCloses.values()].find((run) => !run.retired &&
        run.pair.positions.some((record) => record.positionCommitment === input.positionCommitment));
      if (pending) return await this.commitPairRun(pending,input.positionCommitment);
      if (position.status !== "open" || counterpart.status !== "open") throw new Error("paired position is not open");
      const market = marketConfig(this.executor,input.marketId);
      const [markPrice, currentFundingIndex] = await Promise.all([
        this.currentMarkPriceAsync(market), this.currentFundingIndexAsync(market),
      ]);
      this.validateAt(input, markPrice, currentFundingIndex);
      if (input.currentFundingIndex !== currentFundingIndex) throw new Error("position close funding index mismatch");
      if (input.marginOutputAmount !== positionPayout(store,position,input.markPrice,input.currentFundingIndex)) {
        throw new Error("paired collateral payout mismatch");
      }
      const other = hostedPositionCloseWitness({store,position:counterpart,markPrice:input.markPrice,
        currentFundingIndex:input.currentFundingIndex,assetDigest:input.marginOutputAssetDigest,
        closeCommitment:hashFields("paired-counterparty-close",[input.closeCommitment,counterpart.positionCommitment])});
      if (!this.prover.provePositionClosePairAsync) throw new Error("asynchronous paired close prover is unavailable");
      const pair = await this.prover.provePositionClosePairAsync([input,other.witness],market.maintenanceMarginRate,liquidation);
      const ownNote: StoredMakerNoteRecord = {amount:input.marginOutputAmount.toString(),
        assetDigest:input.marginOutputAssetDigest,blinding:input.marginOutputBlinding,
        commitment:input.marginOutputCommitment,rhoDigest:input.marginOutputRhoDigest,
        ownerCommitment:position.ownerCommitment,ownerDigest:input.ownerDigest,
        spendSecretDigest:input.marginOutputSpendSecretDigest,noteFormat:"secure",
        noteNullifier:secureMarginNullifier({rhoDigest:input.marginOutputRhoDigest,spendSecretDigest:input.marginOutputSpendSecretDigest}),
        closeCommitment:input.closeCommitment,closePositionCommitment:position.positionCommitment};
      const outputNotes: [StoredMakerNoteRecord,StoredMakerNoteRecord] = [ownNote,other.note];
      await this.prepareMakerOutputs([position,counterpart],outputNotes);
      const run: PendingPairedClose = {journalKey:input.closeCommitment,pair,outputNotes,conditional,createdAt:Date.now()};
      this.preparePairAccountEvents(run);
      store.addPendingPairedClose(run);
      await this.flush();
      return await this.commitPairRun(run,input.positionCommitment);
    } finally { locks.delete(lockKey); }
  }

  private async prepareMakerOutputs(positions: [PositionLifecycleRecord,PositionLifecycleRecord], notes: [StoredMakerNoteRecord,StoredMakerNoteRecord]): Promise<void> {
    const maker = this.env.makerWalletAddress?.trim().toUpperCase();
    if (!maker || !this.onchain?.enabled) return;
    const stored = await readMakerNotes();
    const deployment = this.env.stellarDeploymentFile ? loadDeploymentRegistry(this.env.stellarDeploymentFile) : undefined;
    for (let index=0;index<2;index++) {
      const position=positions[index]!;
      if (position.ownerCommitment !== ownerCommitment(maker)) continue;
      const parents=stored.filter((note)=>note.walletAddress===maker && note.status==="spent" &&
        !note.recoveredAmount && note.lockedByIntentCommitment===position.sourceIntentCommitment);
      if (parents.length!==1) throw new Error("paired maker backing note is unavailable or ambiguous");
      const parent=parents[0]!;
      if(!deployment?.contracts["shielded-pool"]||!this.env.collateralTokenContract||
        parent.token!==this.env.collateralTokenContract||parent.assetDigest!==notes[index]!.assetDigest) {
        throw new Error("paired maker backing asset or pool mismatch");
      }
      if(parent.vaultAllocationId) {
        const vault=deployment.contracts["liquidity-vault"];
        if(!vault)throw new Error("paired maker vault is unavailable");
        const verified=vaultMakerPairForTrader({allocations:await readVaultMakerAllocations(),
          asset:this.env.collateralTokenContract,maker,notes:stored,store:this.executor.store,
          trader:positions[index^1]!,vault});
        if(!verified||verified.makerPosition.positionCommitment!==position.positionCommitment||
          verified.makerNote.commitment!==parent.commitment)throw new Error("paired maker backing lineage mismatch");
      }
      Object.assign(notes[index]!,{walletAddress:maker,token:parent.token,
        shieldedPool:deployment?.contracts["shielded-pool"],source:parent.source,
        vaultAllocationId:parent.vaultAllocationId,vaultParentCommitment:parent.commitment,createdAt:Date.now()});
    }
  }

  private async commitPairRun(run: PendingPairedClose, requested = run.pair.positions[0].positionCommitment): Promise<CreatePositionCloseResult> {
    return withPositionMutation(this.executor.store,()=>this.commitPairRunSerialized(run,requested));
  }

  private async commitPairRunSerialized(run: PendingPairedClose, requested:Hex): Promise<CreatePositionCloseResult> {
    const store=this.executor.store;
    const records=run.pair.positions;
    if(!run.accountEvents){this.preparePairAccountEvents(run);store.updatePendingPairedClose(run);await this.flush();}
    // The private recovery journal must be durable before either note-store or chain effects.
    for(const note of run.retired?[]:run.outputNotes) {
      if(note.walletAddress)await insertPendingMakerNote(note as StoredMakerNoteRecord & {commitment:string});
    }
    const statuses=await this.positionCloseStatusesAsync(records);
    if(statuses[0]!==statuses[1])throw new Error("paired settlement status is inconsistent; reconciliation required");
    let settled=statuses.every(Boolean);
    if(run.retired&&!settled)throw new Error("retired paired proof is observation-only");
    const functionName=run.conditional ? "settle_pair_conditional_proven" : "settle_pair_proven";
    if(this.onchain?.enabled && run.settlementTxHash) {
      const status=await this.onchain.positionPairTransactionStatus(run.settlementTxHash);
      if(status==="FAILED") {
        if(settled)throw new Error("paired transaction and contract status disagree");
        await this.discardUnsettledPair(run);
        throw new Error("paired transaction failed; refresh the close context");
      }
      if(status==="SUCCESS" && !settled)throw new Error("confirmed paired close is not visible; reconciliation required");
      if(settled && status!=="SUCCESS")throw new Error("paired close transaction confirmation pending; recovery journal retained");
      if(status==="NOT_FOUND"&&!run.preparedXdr)throw new Error("unknown paired transaction is missing its signed recovery envelope");
    }
    if(this.onchain?.enabled&&run.preparedXdr&&!run.settlementTxHash)throw new Error("paired signed recovery envelope is missing its transaction hash");
    if(this.onchain?.enabled && settled && !run.settlementTxHash)throw new Error("settled pair is missing transaction evidence; reconciliation required");
    if(this.onchain?.enabled && !run.settlementTxHash) {
      const market=marketConfig(this.executor,run.pair.marketId);
      const [markPrice, currentFundingIndex] = await Promise.all([
        this.currentMarkPriceAsync(market), this.currentFundingIndexAsync(market),
      ]);
      if(run.pair.markPrice!==markPrice || run.pair.currentFundingIndex!==currentFundingIndex) {
        await this.discardUnsettledPair(run);
        throw new Error("position close mark price mismatch; refresh the close context");
      }
    }
    if(this.onchain?.enabled&&!settled&&!run.settlementTxHash)assertPositionMutationReady(store,"pair",run.journalKey);
    const relay=settled || !this.onchain?.enabled ? undefined : await this.onchain.settleJournaledPositionPair(
      run.pair,run.conditional,async(prepared)=>{
        run.settlementTxHash=prepared.txHash;run.preparedXdr=prepared.xdr;
        store.updatePendingPairedClose(run);await this.flush();
      },run.settlementTxHash&&run.preparedXdr?{txHash:run.settlementTxHash,xdr:run.preparedXdr}:undefined);
    if (!settled) this.assertSubmittedSettlementRelay(relay,functionName);
    if(this.onchain?.enabled && !settled) {
      settled=(await this.positionCloseStatusesAsync(records)).every(Boolean);
      if(!settled || !run.settlementTxHash || await this.onchain.positionPairTransactionStatus(run.settlementTxHash)!=="SUCCESS") {
        throw new Error("paired close confirmation pending; recovery journal retained");
      }
    }
    const txHash=run.settlementTxHash;
    const committed=records.map((record)=>({...record,...(txHash?{settlementTxHash:txHash}:{}),
      ...(relay?.relays[0]?.txHash?{proofVerificationTxHash:relay.relays[0].txHash}:{})})) as typeof records;
    store.recordProof(run.pair.proof);
    if (!committed.every((record)=>store.positionCloses.has(record.closeCommitment))) {
      if(this.onchain?.enabled) {
        if (!this.onchain.positionCloseAppendIndexAsync) throw new Error("asynchronous close append index reader is unavailable");
        const indices=await Promise.all(committed.map(record=>this.onchain!.positionCloseAppendIndexAsync(record.closeCommitment)));
        const next=store.positionCommitments.size;
        if(indices[0]!==next||indices[1]!==next+1)throw new Error("paired append order differs from local accumulator; recovery journal retained");
      }
      store.addPairedPositionCloses(committed[0],committed[1],run.conditional);
    }
    for(const event of run.accountEvents ?? []) {
      if(event && !store.accountEvents.has(event.eventId))store.addAccountEvent(event);
    }
    await this.flush();
    for (const note of run.outputNotes) {
      if (note.walletAddress) {
        if(!txHash)throw new Error("confirmed maker close transaction hash is required");
        await finalizePendingMakerCloseOutput(String(note.commitment),txHash);
      }
    }
    run.retired=true;
    run.retiredReconciled=true;
    run.retiredReason="confirmed winning close output recovery archive";
    store.updatePendingPairedClose(run);
    await this.flush();
    return committed.find((record)=>record.positionCommitment===requested)!;
  }

  private async discardUnsettledPair(run:PendingPairedClose):Promise<void> {
    run.retired=true;run.retiredReason="submission failed or witness became stale; retain private recovery openings";
    this.executor.store.updatePendingPairedClose(run);await this.flush();
    for(const note of run.outputNotes) {
      if(note.walletAddress)await deleteUnsettledPendingMakerCloseOutput(String(note.commitment),String(note.closePositionCommitment));
    }
  }

  private async observeRetiredPair(run:PendingPairedClose):Promise<void> {
    if(run.retiredReconciled||!this.onchain?.enabled)return;
    const statuses=await this.positionCloseStatusesAsync(run.pair.positions);
    if(!statuses.some(Boolean))return;
    if(!statuses.every(Boolean))throw new Error("archived pair has inconsistent settlement status; openings retained");
    const receipts=await Promise.all(run.pair.positions.map(record=>
      this.onchain!.positionCloseSettlementTransaction(record.closeCommitment)));
    if(receipts[0]!==receipts[1])throw new Error("archived pair legs have different settlement transactions");
    if(await this.onchain.positionPairTransactionStatus(receipts[0]!)!=="SUCCESS") {
      throw new Error("archived pair transaction is not confirmed; openings retained");
    }
    // A public proof may be relayed by a third party after this attempt was retired.
    // Keep every competing attempt's openings, and reconcile the proof that actually won.
    for(const other of this.executor.store.pendingPairedCloses.values()) {
      if(other.journalKey===run.journalKey||other.retired)continue;
      if(other.pair.positions.some(record=>run.pair.positions.some(old=>old.positionCommitment===record.positionCommitment))) {
        await this.discardUnsettledPair(other);
      }
    }
    run.settlementTxHash=receipts[0];run.preparedXdr=undefined;
    this.executor.store.updatePendingPairedClose(run);await this.flush();
    for(const note of run.outputNotes)if(note.walletAddress)await insertPendingMakerNote(note as StoredMakerNoteRecord&{commitment:string});
    await this.commitPairRun(run);
  }

  private preparePairAccountEvents(run:PendingPairedClose):void {
    run.accountEvents=run.pair.positions.map((record,index)=>{
      const position=this.executor.store.positionLifecycle.get(record.positionCommitment);
      if(!position)throw new Error("paired close lifecycle missing");
      const key=this.executor.store.accountEncryptionKey(position.ownerCommitment)?.publicKey;
      return key?createPositionCloseAccountEvent(record,position,key,run.createdAt,run.outputNotes[index]):undefined;
    }) as PendingPairedClose["accountEvents"];
  }

  private async flush(): Promise<void> {
    await (this.executor.store as {flush?:()=>Promise<void>}).flush?.();
  }

  private currentFundingIndex(market: MarketConfig): bigint {
    return this.onchain?.enabled ? this.onchain.marketFundingIndex(market.marketId) : market.fundingIndex;
  }

  private async currentFundingIndexAsync(market: MarketConfig): Promise<bigint> {
    if (!this.onchain?.enabled) return market.fundingIndex;
    if (!this.onchain.marketFundingIndexAsync) throw new Error("asynchronous funding index reader is unavailable");
    return this.onchain.marketFundingIndexAsync(market.marketId);
  }

  private async currentMarkPriceAsync(market: MarketConfig): Promise<bigint> {
    if (!this.onchain?.enabled) return market.oraclePrice;
    if (!this.onchain.marketPriceAsync) throw new Error("asynchronous market price reader is unavailable");
    return this.onchain.marketPriceAsync(market.marketId);
  }

  private async positionCloseStatusesAsync(records: readonly { closeCommitment: Hex }[]): Promise<boolean[]> {
    if (!this.onchain?.enabled) return records.map(() => false);
    if (!this.onchain.isPositionCloseSettledAsync) throw new Error("asynchronous close settlement reader is unavailable");
    return Promise.all(records.map(record => this.onchain!.isPositionCloseSettledAsync(record.closeCommitment)));
  }

  create(input: CreatePositionCloseInput): CreatePositionCloseResult {
    if (this.env.makerWalletAddress && this.onchain?.enabled) {
      throw new Error("vault-backed closes require the proven close route");
    }
    const record = this.prepare(input);
    return this.commit(record);
  }

  createManual(input: CreatePositionCloseInput): CreatePositionCloseResult {
    if (this.env.makerWalletAddress && this.onchain?.enabled) {
      throw new Error("vault-backed closes require the proven close route");
    }
    const record = this.prepare(input);
    return this.commitManual(record);
  }

  async createProven(
    input: CreateProvenPositionCloseInput,
    authenticated?: string,
  ): Promise<CreatePositionCloseResult> {
    this.validateProven(input);
    this.assertCloseOwner(input, authenticated);
    if (this.onchain?.enabled) throw new Error("combined paired close witness is required");
    return this.commit(input);
  }

  async createManualProven(
    input: CreateProvenPositionCloseInput,
    authenticated?: string,
  ): Promise<CreatePositionCloseResult> {
    this.validateProven(input, { requireConditionalTrigger: false });
    this.assertCloseOwner(input, authenticated);
    if (this.onchain?.enabled) throw new Error("combined paired close witness is required");
    return this.commitManual(input);
  }

  assertCloseOwner(record: Pick<CreateProvenPositionCloseInput,"positionCommitment"|"positionNullifier">, authenticated?: string): void {
    const position = this.executor.store.positionFor(record.positionCommitment, record.positionNullifier);
    if (!position || position.positionCommitment !== record.positionCommitment ||
      position.positionNullifier !== record.positionNullifier || position.status !== "open") {
      throw new Error("position is not open");
    }
    assertAuthenticatedOwnerCommitment(authenticated, position.ownerCommitment, "position owner");
  }

  prepare(input: CreatePositionCloseInput): CreatePositionCloseResult {
    this.validate(input);
    return this.prover.provePositionClose(input);
  }

  commit(record: CreatePositionCloseResult): CreatePositionCloseResult {
    const accountEvent = this.accountEventFor(record);
    const relay = this.onchain?.settlePositionClose(record);
    this.assertSubmittedSettlementRelay(relay, "settle");
    const committed = withRelayEvidence(record, relay, "settle");
    this.executor.store.recordProof(committed.proof);
    this.executor.store.addPositionClose(committed);
    if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
    return { ...committed, txHash: committed.settlementTxHash };
  }

  commitManual(record: CreatePositionCloseResult): CreatePositionCloseResult {
    const accountEvent = this.accountEventFor(record);
    const relay = this.onchain?.settleManualPositionClose(record);
    this.assertSubmittedSettlementRelay(relay, "settle_manual");
    const committed = withRelayEvidence(record, relay, "settle_manual");
    this.executor.store.recordProof(committed.proof);
    this.executor.store.addManualPositionClose(committed);
    if (accountEvent) this.executor.store.addAccountEvent(accountEvent);
    return { ...committed, txHash: committed.settlementTxHash };
  }

  validate(input: CreatePositionCloseInput): void {
    const market = marketConfig(this.executor, input.marketId);
    const markPrice = this.currentMarkPrice(market);
    this.validateMarkAndRoot(input, markPrice);
    this.validateAt(input, markPrice, this.currentFundingIndex(market));
  }

  private validateAt(input: CreatePositionCloseInput, markPrice: bigint, currentFundingIndex: bigint): void {
    this.validateMarkAndRoot(input, markPrice);
    assertFundingPayment(input.fundingPayment, input.side, input.size, currentFundingIndex, input.fundingIndex);
  }

  private validateMarkAndRoot(input: CreatePositionCloseInput, markPrice: bigint): void {
    if (input.markPrice !== markPrice) {
      throw new Error("position close mark price mismatch");
    }
    if (!this.executor.store.hasPositionMembershipRoot(input.positionRoot)) {
      throw new Error("position root is not recognized");
    }
  }

  validateProven(
    input: CreateProvenPositionCloseInput,
    options: { requireConditionalTrigger?: boolean } = { requireConditionalTrigger: true },
  ): void {
    const market = marketConfig(this.executor, input.marketId);
    if (input.markPrice !== this.currentMarkPrice(market)) {
      throw new Error("position close mark price mismatch");
    }
    if (!this.executor.store.hasPositionMembershipRoot(input.positionRoot)) {
      throw new Error("position root is not recognized");
    }
    if (options.requireConditionalTrigger ?? true) {
      const conditionalClose = this.executor.store.conditionalCloses.get(input.closeCommitment);
      if (!conditionalClose) {
        throw new Error("conditional close not triggered");
      }
      if (
        conditionalClose.marketId !== input.marketId ||
        conditionalClose.positionNullifier !== input.positionNullifier ||
        conditionalClose.markPrice !== input.markPrice
      ) {
        throw new Error("conditional close not triggered");
      }
    }
    if (input.proof.circuitId !== "position-close") {
      throw new Error("position close proof circuit mismatch");
    }
    this.prover.assertBoundProof(
      input.proof,
      "position-close",
      contractPublicInputHash([
        publicU128(input.markPrice),
        publicU128(PRICE_SCALE),
        publicField(input.positionRoot),
        publicField(input.positionCommitment),
        publicField(input.positionNullifier),
        publicField(input.closeCommitment),
        publicField(input.newPositionCommitment),
        publicField(input.marginOutputCommitment),
        publicField(hashFields("market-id", [input.marketId])),
        publicI128(input.currentFundingIndex),
      ]),
    );
  }

  private assertSubmittedSettlementRelay(
    result: OnchainRelayResult | undefined,
    functionName: string,
  ): void {
    if (!this.env.settlementsOnchainRequired) return;
    if (!this.onchain || !this.onchain.enabled) {
      throw new Error("settlements require on-chain relay");
    }
    assertSubmittedRelay(result, functionName);
  }

  private currentMarkPrice(market: MarketConfig): bigint {
    return this.onchain?.enabled
      ? this.onchain.marketPrice(market.marketId)
      : market.oraclePrice;
  }

  private accountEventFor(record: CreatePositionCloseResult) {
    const position = this.executor.store.positionFor(record.positionCommitment, record.positionNullifier);
    if (!position) return undefined;
    const publicKey = this.executor.store.accountEncryptionKey(position.ownerCommitment)?.publicKey;
    if (!publicKey) return undefined;
    return createPositionCloseAccountEvent(record, position, publicKey);
  }
}

function withRelayEvidence(
  record: CreatePositionCloseResult,
  result: OnchainRelayResult | undefined,
  settlementFunction: "settle" | "settle_manual" | "settle_pair_manual" | "settle_pair_conditional",
): CreatePositionCloseResult {
  const proofVerificationTxHash = result?.relays.find(
    (relay) => relay.functionName === "verify_and_record" && relay.submitted,
  )?.txHash;
  const settlementTxHash = result?.relays.find(
    (relay) => relay.functionName === settlementFunction && relay.submitted,
  )?.txHash;
  return {
    ...record,
    ...(proofVerificationTxHash ? { proofVerificationTxHash } : {}),
    ...(settlementTxHash ? { settlementTxHash } : {}),
  };
}

function marketConfig(executor: ExecutorService, marketId: string): MarketConfig {
  const market = executor.store.markets.get(marketId);
  if (!market) throw new Error("unknown market");
  return market;
}
