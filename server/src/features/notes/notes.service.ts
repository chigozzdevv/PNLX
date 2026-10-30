import { assertAuthenticatedAccount } from "@/shared/http/auth-context";
import { contractPublicInputHash, publicField, publicU128 } from "@pnlx/proof-system";
import { hashFields, secureMarginRoot } from "@pnlx/crypto";
import { withPositionMutation } from "@/shared/protocol/position-mutation";
import { depositRecoveryNetworkHash, StellarConfirmedDepositRecovery, type ConfirmedDepositRecoveryReader } from "@/features/notes/confirmed-deposit-recovery";
import type { ServerEnv } from "@/config/env";
import type { DepositNoteRecord, DepositNoteWitness, Hex, PendingAssetDepositRecord } from "@pnlx/protocol-types";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { OnchainRelayService } from "@/workers/onchain/onchain.service";
import type { ProverService } from "@/workers/prover/prover.service";
import type {
  AssetDepositNoteInput,
  AssetDepositStatusInput,
  AssetDepositNoteResult,
  DepositNoteInput,
  DepositNoteResult,
  FinalizeAssetDepositInput,
  RecoverConfirmedAssetDepositInput,
  RecoveredAssetDepositNoteResult,
  PrepareAssetDepositResult,
  ProvenAssetDepositNoteInput,
  ProvenWithdrawAssetNoteInput,
  ProvenWithdrawNoteInput,
  WithdrawNoteInput,
  WithdrawNoteResult,
  WithdrawAssetNoteInput,
  WithdrawAssetNoteResult,
} from "@/features/notes/notes.model";
import type { OnchainRelayResult } from "@/workers/onchain/onchain.model";
import { assertSubmittedRelay } from "@/shared/protocol/onchain-submission";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import type { RelayedTx } from "@/workers/relayer/relayer.model";

export class NotesService {
  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly env: ServerEnv,
    private readonly onchain?: OnchainRelayService,
    private readonly relayer?: Pick<RelayerService, "find">,
    private readonly depositRecovery?: ConfirmedDepositRecoveryReader,
  ) {}

  async depositAssetStatus(input: AssetDepositStatusInput, authenticated?: string) {
    if (!authenticated) throw new Error("authenticated deposit owner is required");
    const store = this.executor.store;
    const pending = store.pendingAssetDeposits.get(input.commitment);
    if (!pending) throw new Error("pending asset deposit not found");
    assertAuthenticatedAccount(authenticated, pending.from, "deposit owner");
    this.assertCollateralToken(pending.token);
    const result = { commitment: pending.commitment, expectedTxHash: input.expectedTxHash,
      from: pending.from, token: pending.token, tokenDigest: pending.tokenDigest, amount: pending.amount,
      transactionStatus: undefined as "SUCCESS" | "FAILED" | "NOT_FOUND" | undefined, canRetry: false };
    const unchanged = () => store.pendingAssetDeposits.get(input.commitment) === pending &&
      pending.commitment === input.commitment && pending.preparedTxHash === input.expectedTxHash &&
      !pending.finalizedAt && !pending.confirmedRecovery && !pending.txHash &&
      !store.marginCommitments.has(input.commitment) && pending.from === result.from &&
      pending.token === result.token && pending.tokenDigest === result.tokenDigest && pending.amount === result.amount &&
      pending.depositProof.commitment === pending.commitment && pending.depositProof.amount === pending.amount &&
      pending.depositProof.tokenDigest === pending.tokenDigest;
    if (!unchanged() || !this.onchain?.enabled) return result;
    try {
      result.transactionStatus = await this.onchain.depositTransactionStatusAsync(input.expectedTxHash);
      if (result.transactionStatus !== "FAILED") return result;
      const recorded = await this.onchain.isMarginCommitmentRecordedAsync(input.commitment);
      result.canRetry = recorded === false && unchanged();
    } catch { /* Missing or unavailable chain evidence never permits a replacement. */ }
    return result;
  }

  deposit(input: DepositNoteInput): DepositNoteResult {
    if (this.env.assetCustodyRequired) {
      throw new Error("plain deposits disabled; use asset-backed deposit");
    }
    this.onchain?.deposit(input.commitment);
    this.executor.deposit(input.commitment);
    const membershipProof = this.executor.store.marginMembershipProof(input.commitment);
    return {
      commitment: input.commitment,
      membershipProof,
      membershipRoot: membershipProof.root,
      marginRoot: this.executor.store.marginRoot(),
    };
  }

  membership(commitment: Hex): DepositNoteResult {
    this.syncSecureNotes();
    if (!this.executor.store.marginCommitments.has(commitment)) {
      throw new Error("margin note not found");
    }
    const membershipProof = this.executor.store.marginMembershipProof(commitment);
    return {
      commitment,
      membershipProof,
      membershipRoot: membershipProof.root,
      marginRoot: this.executor.store.marginRoot(),
    };
  }

  addressDigest(address: string): Hex {
    return this.requireOnchain().tokenDigest(address);
  }

  prepareDepositAsset(
    input: AssetDepositNoteInput,
    authenticated?: string,
  ): PrepareAssetDepositResult {
    assertAuthenticatedAccount(authenticated, input.from, "from");
    this.assertCollateralToken(input.token);
    const onchain = this.requireOnchain();
    this.assertCollateralFunding(input, onchain);
    const depositProof = this.prover.proveSecureDepositNote(assetDepositWitness(input));
    const proofVerification = onchain.verifyProof(depositProof.proof);
    this.assertSubmittedCustodyRelay(proofVerification, "verify_and_record");
    const action = onchain.prepareDepositAsset({ ...input, depositProof });
    const pendingDeposit = this.recordPendingDeposit(input, depositProof, action.xdr, action.txHash);
    return {
      action,
      depositProof,
      pendingDeposit,
      proofVerification,
    };
  }

  prepareDepositAssetProven(
    input: ProvenAssetDepositNoteInput,
    authenticated?: string,
  ): PrepareAssetDepositResult {
    assertAuthenticatedAccount(authenticated, input.from, "from");
    this.assertCollateralToken(input.token);
    this.assertDepositProof(input);
    const onchain = this.requireOnchain();
    this.assertCollateralFunding(input, onchain);
    const proofVerification = onchain.verifyProof(input.depositProof.proof);
    this.assertSubmittedCustodyRelay(proofVerification, "verify_and_record");
    const action = onchain.prepareDepositAsset({ ...input, depositProof: input.depositProof });
    const pendingDeposit = this.recordPendingDeposit(input, input.depositProof, action.xdr, action.txHash);
    return {
      action,
      depositProof: input.depositProof,
      pendingDeposit,
      proofVerification,
    };
  }

  async prepareDepositAssetDurable(input: AssetDepositNoteInput, authenticated?: string): Promise<PrepareAssetDepositResult> {
    const prepared = this.prepareDepositAsset(input, authenticated);
    await this.flushStore();
    return prepared;
  }

  async prepareDepositAssetProvenDurable(input: ProvenAssetDepositNoteInput, authenticated?: string): Promise<PrepareAssetDepositResult> {
    const prepared = this.prepareDepositAssetProven(input, authenticated);
    await this.flushStore();
    return prepared;
  }

  finalizeDepositAsset(
    input: FinalizeAssetDepositInput,
    authenticated?: string,
  ): AssetDepositNoteResult {
    assertAuthenticatedAccount(authenticated, input.from, "from");
    this.assertCollateralToken(input.token);
    this.assertDepositProof(input);
    const pending = this.assertPendingDeposit(input);
    const relay = this.assertSubmittedPreparedDepositRelay(input.relayId, pending, authenticated);
    this.executor.store.recordProof(input.depositProof.proof);
    this.syncSecureNotes();
    if (!this.executor.store.marginCommitments.has(input.commitment)) {
      throw new Error("deposit commitment was not recorded on-chain");
    }
    this.executor.store.finalizePendingAssetDeposit(input.commitment, relay);
    const membershipProof = this.executor.store.marginMembershipProof(input.commitment);
    return {
      amount: input.amount,
      commitment: input.commitment,
      depositProof: input.depositProof,
      from: input.from,
      membershipProof,
      membershipRoot: membershipProof.root,
      marginRoot: this.executor.store.marginRoot(),
      onchain: { relays: [relay] },
      token: input.token,
    };
  }

  async recoverConfirmedDepositAsset(
    input: RecoverConfirmedAssetDepositInput,
    authenticated?: string,
  ): Promise<RecoveredAssetDepositNoteResult> {
    if (!authenticated) throw new Error("authenticated deposit owner is required");
    return withPositionMutation(this.executor.store, async () => {
      const store = this.executor.store, pending = store.pendingAssetDeposits.get(input.commitment);
      if (!pending) throw new Error("pending asset deposit not found");
      if (typeof pending.from !== "string" || !pending.from.trim()) {
        throw new Error("pending asset deposit owner is missing");
      }
      assertAuthenticatedAccount(authenticated, pending.from, "deposit owner");
      this.requireOnchain();
      this.assertCollateralToken(pending.token);
      if (!pending.preparedTxHash || !/^0x[0-9a-f]{64}$/i.test(pending.preparedTxHash) ||
          !/^0x[0-9a-f]{64}$/i.test(pending.preparedXdrDigest) ||
          pending.tokenDigest !== pending.depositProof.tokenDigest) {
        throw new Error("pending deposit lacks a valid prepared transaction binding");
      }
      this.assertDepositProof(pending);
      let confirmation = pending.confirmedRecovery;
      if (pending.finalizedAt && confirmation) {
        if (confirmation.txHash !== pending.preparedTxHash || pending.txHash !== pending.preparedTxHash ||
            confirmation.network !== this.env.stellarNetwork ||
            confirmation.networkPassphraseHash !== depositRecoveryNetworkHash(this.env.stellarNetworkPassphrase) ||
            !store.marginCommitments.has(pending.commitment) || !store.hasProof(pending.depositProof.proof)) {
          throw new Error("confirmed deposit recovery record is inconsistent");
        }
        store.confirmPendingAssetDeposit(pending.commitment, confirmation, [...store.marginCommitments]);
      } else {
        const observed = await (this.depositRecovery ?? new StellarConfirmedDepositRecovery(this.env))
          .read(pending, [...store.marginCommitments]);
        confirmation = observed.confirmation;
        if (confirmation.network !== this.env.stellarNetwork ||
            confirmation.networkPassphraseHash !== depositRecoveryNetworkHash(this.env.stellarNetworkPassphrase) ||
            secureMarginRoot(observed.commitments) !== observed.root) {
          throw new Error("confirmed deposit recovery network or membership mismatch");
        }
        store.confirmPendingAssetDeposit(pending.commitment, confirmation, observed.commitments);
      }
      await this.flushStore();
      const membershipProof = store.marginMembershipProof(pending.commitment);
      return { amount: pending.amount, commitment: pending.commitment, depositProof: pending.depositProof,
        from: pending.from, token: pending.token, membershipProof, membershipRoot: membershipProof.root,
        marginRoot: store.marginRoot(), onchain: {relays: []}, confirmedRecovery: confirmation };
    });
  }

  depositAsset(input: AssetDepositNoteInput, authenticated?: string): AssetDepositNoteResult {
    assertAuthenticatedAccount(authenticated, input.from, "from");
    this.assertCollateralToken(input.token);
    const onchainRelay = this.requireOnchain();
    this.assertCollateralFunding(input, onchainRelay);
    const depositProof = this.prover.proveSecureDepositNote(assetDepositWitness(input));
    const onchain = onchainRelay.depositAsset({ ...input, depositProof });
    this.assertSubmittedCustodyRelay(onchain, "deposit_asset_secure");
    this.syncSecureNotes();
    if (!this.executor.store.marginCommitments.has(input.commitment)) {
      throw new Error("deposit commitment was not recorded on-chain");
    }
    const membershipProof = this.executor.store.marginMembershipProof(input.commitment);
    return {
      amount: input.amount,
      commitment: input.commitment,
      depositProof,
      from: input.from,
      membershipProof,
      membershipRoot: membershipProof.root,
      marginRoot: this.executor.store.marginRoot(),
      onchain,
      token: input.token,
    };
  }

  depositAssetProven(input: ProvenAssetDepositNoteInput, authenticated?: string): AssetDepositNoteResult {
    assertAuthenticatedAccount(authenticated, input.from, "from");
    this.assertCollateralToken(input.token);
    this.assertDepositProof(input);
    const onchainRelay = this.requireOnchain();
    this.assertCollateralFunding(input, onchainRelay);
    const onchain = onchainRelay.depositAsset({ ...input, depositProof: input.depositProof });
    this.assertSubmittedCustodyRelay(onchain, "deposit_asset_secure");
    this.executor.store.recordProof(input.depositProof.proof);
    this.syncSecureNotes();
    if (!this.executor.store.marginCommitments.has(input.commitment)) {
      throw new Error("deposit commitment was not recorded on-chain");
    }
    const membershipProof = this.executor.store.marginMembershipProof(input.commitment);
    return {
      amount: input.amount,
      commitment: input.commitment,
      depositProof: input.depositProof,
      from: input.from,
      membershipProof,
      membershipRoot: membershipProof.root,
      marginRoot: this.executor.store.marginRoot(),
      onchain,
      token: input.token,
    };
  }

  withdraw(input: WithdrawNoteInput): WithdrawNoteResult {
    if (this.env.assetCustodyRequired) {
      throw new Error("plain withdrawals disabled; use asset-backed withdrawal");
    }
    this.assertWithdrawalRoot(input.root);
    const record = this.prover.proveSecureWithdrawal(input);
    this.onchain?.withdraw(record);
    this.executor.store.recordProof(record.proof);
    this.executor.store.addWithdrawal(record);
    return record;
  }

  withdrawProven(input: ProvenWithdrawNoteInput): WithdrawNoteResult {
    if (this.env.assetCustodyRequired) {
      throw new Error("plain withdrawals disabled; use asset-backed withdrawal");
    }
    this.assertWithdrawalRecord(input);
    this.onchain?.withdraw(input);
    this.executor.store.recordProof(input.proof);
    this.executor.store.addWithdrawal(input);
    return input;
  }

  withdrawAsset(input: WithdrawAssetNoteInput): WithdrawAssetNoteResult {
    this.syncSecureNotes();
    this.assertCollateralToken(input.token);
    const onchainRelay = this.requireOnchain();
    const recipientDigest = onchainRelay.tokenDigest(input.recipientAddress);
    const request = {
      ...input,
      recipient: recipientDigest,
      recipientDigest,
    };
    this.assertWithdrawalRoot(request.root);
    const withdrawal = this.prover.proveSecureWithdrawal(request);
    const record = {
      ...withdrawal,
      recipientAddress: request.recipientAddress,
      token: request.token,
    };
    const onchain = onchainRelay.withdrawAsset(record);
    this.assertSubmittedCustodyRelay(onchain, "withdraw_asset_secure");
    this.executor.store.recordProof(record.proof);
    this.executor.store.addWithdrawal(record);
    return record;
  }

  withdrawAssetProven(input: ProvenWithdrawAssetNoteInput): WithdrawAssetNoteResult {
    this.syncSecureNotes();
    this.assertCollateralToken(input.token);
    this.assertWithdrawalRecord(input);
    const onchain = this.requireOnchain().withdrawAsset(input);
    this.assertSubmittedCustodyRelay(onchain, "withdraw_asset_secure");
    this.executor.store.recordProof(input.proof);
    this.executor.store.addWithdrawal(input);
    return input;
  }

  private async flushStore(): Promise<void> {
    await (this.executor.store as {flush?:()=>Promise<void>}).flush?.();
  }

  private requireOnchain(): OnchainRelayService {
    if (!this.onchain || !this.onchain.enabled) {
      throw new Error("asset custody requires on-chain relay");
    }
    return this.onchain;
  }

  private syncSecureNotes(): void {
    if (!this.env.assetCustodyRequired) return;
    const snapshot = this.requireOnchain().secureNoteSnapshot(
      [...this.executor.store.marginCommitments]);
    if (snapshot.root !== this.executor.store.marginMembershipRoot()) {
      this.executor.store.replaceMarginCommitments(snapshot.commitments);
    }
  }

  private assertCollateralToken(token: string): void {
    const configuredToken = this.env.collateralTokenContract.trim().toUpperCase();
    if (!configuredToken) {
      if (this.env.assetCustodyRequired) {
        throw new Error("collateral token contract not configured");
      }
      return;
    }
    if (token.trim().toUpperCase() !== configuredToken) {
      throw new Error("unsupported collateral token");
    }
  }

  private assertSubmittedCustodyRelay(result: OnchainRelayResult, functionName: string): void {
    if (!this.env.assetCustodyRequired) return;
    assertSubmittedRelay(result, functionName);
  }

  private assertCollateralFunding(
    input: Pick<ProvenAssetDepositNoteInput, "amount" | "from" | "source" | "token">,
    onchain: Pick<OnchainRelayService, "assetBalance">,
  ): void {
    let balance: bigint;
    try {
      balance = onchain.assetBalance(input.token, input.from, input.source);
    } catch (error) {
      if (error instanceof Error && error.message.includes("collateral trustline is missing")) {
        throw new Error(`${this.collateralLabel()} trustline is missing for this wallet`);
      }
      throw error;
    }
    if (balance < input.amount) {
      throw new Error(`Insufficient ${this.collateralLabel()} balance for private margin`);
    }
  }

  private collateralLabel(): string {
    return this.env.collateralAssetCode || "collateral";
  }

  private recordPendingDeposit(
    input: Pick<ProvenAssetDepositNoteInput, "amount" | "commitment" | "from" | "token">,
    depositProof: DepositNoteRecord,
    preparedXdr: string | undefined,
    preparedTxHash?: Hex,
  ): PendingAssetDepositRecord {
    if (!preparedXdr) {
      throw new Error("asset deposit preparation did not return wallet transaction xdr");
    }
    const pendingDeposit = {
      amount: input.amount,
      commitment: input.commitment,
      createdAt: Date.now(),
      depositProof,
      from: input.from,
      preparedTxHash,
      preparedXdrDigest: hashFields("prepared-asset-deposit-xdr", [preparedXdr]),
      token: input.token,
      tokenDigest: depositProof.tokenDigest,
    };
    this.executor.store.addPendingAssetDeposit(pendingDeposit);
    return pendingDeposit;
  }

  private assertPendingDeposit(input: FinalizeAssetDepositInput): PendingAssetDepositRecord {
    const pending = this.executor.store.pendingAssetDeposits.get(input.commitment);
    if (!pending) throw new Error("pending asset deposit not found");
    if (pending.finalizedAt) throw new Error("asset deposit already finalized");
    if (pending.amount !== input.amount) throw new Error("pending asset deposit amount mismatch");
    if (pending.from.trim().toUpperCase() !== input.from.trim().toUpperCase()) {
      throw new Error("pending asset deposit source mismatch");
    }
    if (pending.token.trim().toUpperCase() !== input.token.trim().toUpperCase()) {
      throw new Error("pending asset deposit token mismatch");
    }
    if (pending.tokenDigest !== input.depositProof.tokenDigest) {
      throw new Error("pending asset deposit proof mismatch");
    }
    if (pending.depositProof.proof.proofDigest !== input.depositProof.proof.proofDigest) {
      throw new Error("pending asset deposit proof mismatch");
    }
    return pending;
  }

  private assertSubmittedPreparedDepositRelay(
    relayId: Hex,
    pending: PendingAssetDepositRecord,
    authenticated?: string,
  ): RelayedTx {
    const relay = this.relayer?.find(relayId);
    if (!relay) throw new Error("signed deposit relay not found");
    if (relay.kind !== "signed-xdr" || relay.functionName !== "tx send") {
      throw new Error("signed deposit relay is not a wallet transaction");
    }
    if (!relay.submitted || !relay.txHash) {
      throw new Error("deposit_asset_secure transaction was not submitted");
    }
    if (relay.commitment !== pending.commitment) {
      throw new Error("signed deposit relay commitment mismatch");
    }
    if (relay.preparedXdrDigest !== pending.preparedXdrDigest) {
      throw new Error("signed deposit relay prepared transaction mismatch");
    }
    if (authenticated) {
      if (!relay.submittedBy) {
        throw new Error("signed deposit relay submitter missing");
      }
      if (relay.submittedBy.trim().toUpperCase() !== authenticated.trim().toUpperCase()) {
        throw new Error("signed deposit relay submitter mismatch");
      }
    }
    return relay;
  }

  private assertWithdrawalRoot(root: `0x${string}`): void {
    if (root !== this.executor.store.marginMembershipRoot()) {
      throw new Error("withdrawal root is not current");
    }
  }

  private assertDepositProof(input: ProvenAssetDepositNoteInput): void {
    if (input.depositProof.amount !== input.amount) {
      throw new Error("asset deposit proof amount mismatch");
    }
    if (input.depositProof.commitment !== input.commitment) {
      throw new Error("asset deposit proof commitment mismatch");
    }
    if (input.depositProof.proof.circuitId !== "secure-deposit-note") {
      throw new Error("asset deposit proof circuit mismatch");
    }
    this.prover.assertBoundProof(
      input.depositProof.proof,
      "secure-deposit-note",
      contractPublicInputHash([
        publicU128(input.amount),
        publicField(input.depositProof.tokenDigest),
        publicField(input.commitment),
      ]),
    );
  }

  private assertWithdrawalRecord(input: ProvenWithdrawNoteInput): void {
    this.assertWithdrawalRoot(input.root);
    if (input.withdrawAmount <= 0n) throw new Error("withdraw amount must be positive");
    if (input.proof.circuitId !== "secure-withdraw") {
      throw new Error("withdrawal proof circuit mismatch");
    }
    this.prover.assertBoundProof(
      input.proof,
      "secure-withdraw",
      contractPublicInputHash([
        publicU128(input.withdrawAmount),
        publicField(input.root),
        publicField(input.nullifier),
        publicField(input.tokenDigest),
        publicField(input.recipient),
        publicField(input.changeCommitment),
      ]),
    );
  }
}

function assetDepositWitness(input: AssetDepositNoteInput): DepositNoteWitness & { spendSecretDigest: Hex } {
  return {
    amount: input.amount,
    blinding: requiredHex(input.blinding, "blinding"),
    commitment: input.commitment,
    ownerDigest: requiredHex(input.ownerDigest, "ownerDigest"),
    rhoDigest: requiredHex(input.rhoDigest, "rhoDigest"),
    spendSecretDigest: requiredHex(input.spendSecretDigest, "spendSecretDigest"),
    tokenDigest: requiredHex(input.tokenDigest, "tokenDigest"),
  };
}

function requiredHex(value: Hex | undefined, field: string): Hex {
  if (!value) throw new Error(`${field} is required`);
  return value;
}
