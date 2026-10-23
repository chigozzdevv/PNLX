import {
  FIELD_MERKLE_DEPTH,
  POSITION_MERKLE_DEPTH,
  circuitDisclosureCommitment,
  circuitMarginCommitment,
  circuitNullifier,
  circuitPositionCommitment,
  circuitPositionNullifier,
  conditionalOrderBindingFields,
  commitConditionalOrder,
  commitIntent,
  fieldHashPair,
  hashFields,
  intentBindingFields,
  mod,
  secureMarginCommitment,
  secureMarginNullifier,
  derivePositionSeed,
  circuitMatchingPayloadCommitment,
} from "@pnlx/crypto";
import { isLiquidatable, PRICE_SCALE, RATE_SCALE, settleClose } from "@pnlx/market-math";
import {
  bindProof,
  buildProofArtifact,
  buildProofArtifactAsync,
  circuitKey,
  loadCircuit,
  publicInputDigest,
  type ProofArtifact,
  type ProofArtifactOptions,
  type CircuitId,
} from "@pnlx/proof-system";
import type {
  ConditionalOrderRecord,
  DisclosureRecord,
  DepositNoteRecord,
  Hex,
  FundingSettlementRecord,
  IntentValidityRecord,
  LiquidationRecord,
  PositionCloseRecord,
  PairedPositionCloseRecord,
  ProofMeta,
  SecureDepositNoteWitness,
  WithdrawalRecord,
} from "@pnlx/protocol-types";
import type {
  ConditionalCloseProofInput,
  DepositNoteProofInput,
  DisclosureProofInput,
  FundingSettlementProofInput,
  IntentValidityProofInput,
  LiquidationProofInput,
  PositionCloseProofInput,
  Prover,
  WithdrawalProofInput,
} from "@/workers/prover/prover.model";
import { ProofArtifactRegistry, proofKey } from "@/shared/proofs/artifact-registry";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ZERO_HEX = "0x0" as Hex;

interface PositionClosePairProofPlan {
  inputs: [PositionCloseProofInput, PositionCloseProofInput];
  maintenanceRate: bigint;
  liquidation: boolean;
  publicInputs: Hex;
  artifactOptions: ProofArtifactOptions;
}

export class ProverService implements Prover {
  private readonly artifacts = new Map<string, ProofArtifact>();
  private readonly intentValidityRecords = new Map<string, IntentValidityRecord>();
  private readonly artifactRegistry: ProofArtifactRegistry;

  constructor(private readonly root = process.cwd()) {
    this.artifactRegistry = new ProofArtifactRegistry(join(root, ".pnlx", "proof-artifacts.json"));
  }

  artifactFor(proof: ProofMeta): ProofArtifact | undefined {
    return this.artifacts.get(proofKey(proof)) ?? this.artifactRegistry.get(proof);
  }

  registerProofArtifact(input: {
    bytecodeHash?: Hex;
    proof: ProofMeta;
    proofBase64: string;
    publicInputsBase64: string;
    vkBase64: string;
    witnessHash?: Hex;
  }): ProofArtifact {
    const circuit = loadCircuit(this.root, input.proof.circuitId as CircuitId);
    if (input.proof.circuitKey !== circuitKey(circuit.id)) {
      throw new Error("proof circuit key mismatch");
    }
    if (input.proof.circuitHash !== circuit.sourceHash) {
      throw new Error("proof circuit hash mismatch");
    }

    const dir = join(
      this.root,
      ".pnlx",
      "client-proof-artifacts",
      createHash("sha256").update(proofKey(input.proof)).digest("hex"),
    );
    mkdirSync(dir, { recursive: true });
    const proofPath = join(dir, "proof");
    const publicInputsPath = join(dir, "public_inputs");
    const vkPath = join(dir, "vk");
    writeFileSync(proofPath, Buffer.from(input.proofBase64, "base64"));
    writeFileSync(publicInputsPath, Buffer.from(input.publicInputsBase64, "base64"));
    writeFileSync(vkPath, Buffer.from(input.vkBase64, "base64"));

    const proofHash = fileHash(proofPath);
    const publicInputsHash = fileHash(publicInputsPath);
    const vkHash = fileHash(vkPath);
    if (proofHash !== input.proof.proofDigest) {
      throw new Error("proof artifact digest mismatch");
    }
    if (publicInputsHash !== input.proof.publicInputHash) {
      throw new Error("proof artifact public input mismatch");
    }
    if (vkHash !== input.proof.verifierHash) {
      throw new Error("proof artifact verifier mismatch");
    }
    if (input.proof.proofHash && input.proof.proofHash !== proofHash) {
      throw new Error("proof hash mismatch");
    }
    if (input.proof.publicInputsHash && input.proof.publicInputsHash !== publicInputsHash) {
      throw new Error("proof public input hash mismatch");
    }
    if (input.proof.vkHash && input.proof.vkHash !== vkHash) {
      throw new Error("proof verifier hash mismatch");
    }

    const bytecodeHash = input.bytecodeHash ?? input.proof.bytecodeHash ?? "0x0";
    const witnessHash = input.witnessHash ?? input.proof.witnessHash ?? "0x0";
    if (input.proof.bytecodeHash && input.proof.bytecodeHash !== bytecodeHash) {
      throw new Error("proof bytecode hash mismatch");
    }
    if (input.proof.witnessHash && input.proof.witnessHash !== witnessHash) {
      throw new Error("proof witness hash mismatch");
    }

    const artifact = {
      bytecodeHash,
      circuitId: circuit.id,
      circuitKey: input.proof.circuitKey,
      proofHash,
      proofPath,
      publicInputsHash,
      publicInputsPath,
      vkHash,
      vkPath,
      witnessHash,
    };
    this.artifacts.set(proofKey(input.proof), artifact);
    this.artifactRegistry.set(input.proof, artifact);
    return artifact;
  }

  intentValidityFor(proof: ProofMeta): IntentValidityRecord | undefined {
    return this.intentValidityRecords.get(proofKey(proof));
  }

  assertBoundProof(
    proof: ProofMeta,
    expectedCircuitId: CircuitId,
    expectedPublicInputHash: Hex,
  ): void {
    const circuit = loadCircuit(this.root, expectedCircuitId);
    if (proof.circuitId !== expectedCircuitId) {
      throw new Error("proof circuit mismatch");
    }
    if (proof.circuitKey !== circuitKey(expectedCircuitId)) {
      throw new Error("proof circuit key mismatch");
    }
    if (proof.circuitHash !== circuit.sourceHash) {
      throw new Error("proof circuit hash mismatch");
    }
    if (proof.publicInputHash !== expectedPublicInputHash) {
      throw new Error("proof public input mismatch");
    }

    const artifact = this.artifactFor(proof);
    if (!artifact) throw new Error("proof artifact not found");
    if (artifact.circuitId !== expectedCircuitId) {
      throw new Error("proof artifact circuit mismatch");
    }
    if (artifact.circuitKey !== proof.circuitKey) {
      throw new Error("proof artifact circuit key mismatch");
    }
    if (artifact.publicInputsHash !== proof.publicInputHash) {
      throw new Error("proof artifact public input mismatch");
    }
    if (artifact.proofHash !== proof.proofDigest) {
      throw new Error("proof artifact digest mismatch");
    }
    if (artifact.vkHash !== proof.verifierHash) {
      throw new Error("proof artifact verifier mismatch");
    }
    if (proof.publicInputsHash && proof.publicInputsHash !== proof.publicInputHash) {
      throw new Error("proof public input hash mismatch");
    }
    if (proof.proofHash && proof.proofHash !== proof.proofDigest) {
      throw new Error("proof hash mismatch");
    }
    if (proof.vkHash && proof.vkHash !== proof.verifierHash) {
      throw new Error("proof verifier hash mismatch");
    }
    if (proof.bytecodeHash && proof.bytecodeHash !== artifact.bytecodeHash) {
      throw new Error("proof bytecode hash mismatch");
    }

    assertFileHash(artifact.publicInputsPath, proof.publicInputHash, "proof public input file");
    assertFileHash(artifact.proofPath, proof.proofDigest, "proof file");
    assertFileHash(artifact.vkPath, proof.verifierHash, "proof verifier key file");
  }

  proveFundingSettlement(input: FundingSettlementProofInput): FundingSettlementRecord {
    if (input.newFundingIndex === input.oldFundingIndex) {
      throw new Error("invalid funding index");
    }
    if (input.markPrice <= 0n) throw new Error("mark price must be positive");
    if (input.elapsedMs <= 0) throw new Error("elapsed time must be positive");
    if (input.intervalMs <= 0) throw new Error("funding interval must be positive");
    if (input.maxFundingDelta !== undefined && input.maxFundingDelta <= 0n) {
      throw new Error("max funding delta must be positive when enabled");
    }

    const maxDelta = input.maxFundingDelta ?? 0n;
    const maxDeltaEnabled = input.maxFundingDelta === undefined ? 0n : 1n;
    const fundingDelta = input.newFundingIndex - input.oldFundingIndex;
    const marketDigest = hashFields("market-id", [input.marketId]);
    const oldIndex = signedParts(input.oldFundingIndex);
    const newIndex = signedParts(input.newFundingIndex);
    const premium = signedParts(input.premiumRate);
    const publicInputs = publicInputDigest("funding-update", [
      marketDigest,
      oldIndex.abs,
      oldIndex.isNegative,
      newIndex.abs,
      newIndex.isNegative,
      input.markPrice,
      premium.abs,
      premium.isNegative,
      BigInt(input.elapsedMs),
      BigInt(input.intervalMs),
      maxDelta,
      maxDeltaEnabled,
    ]);
    const artifact = buildProofArtifact(this.root, "funding-update", {
      name: artifactName("funding", [
        input.marketId,
        input.oldFundingIndex,
        input.newFundingIndex,
        input.appliedAt,
      ]),
      inputs: {
        market_id: field(marketDigest),
        old_index_abs: oldIndex.abs,
        old_index_is_negative: oldIndex.isNegative,
        new_index_abs: newIndex.abs,
        new_index_is_negative: newIndex.isNegative,
        mark_price: input.markPrice,
        premium_rate_abs: premium.abs,
        premium_rate_is_negative: premium.isNegative,
        elapsed_ms: BigInt(input.elapsedMs),
        interval_ms: BigInt(input.intervalMs),
        max_delta: maxDelta,
        max_delta_enabled: maxDeltaEnabled,
      },
    });
    const proof = this.bindArtifact("funding-update", publicInputs, artifact);

    return {
      appliedAt: input.appliedAt,
      elapsedMs: input.elapsedMs,
      fundingDelta,
      intervalMs: input.intervalMs,
      markPrice: input.markPrice,
      marketId: input.marketId,
      maxFundingDelta: input.maxFundingDelta,
      newFundingIndex: input.newFundingIndex,
      oldFundingIndex: input.oldFundingIndex,
      premiumRate: input.premiumRate,
      proof,
    };
  }

  proveDepositNote(input: DepositNoteProofInput): DepositNoteRecord {
    if (input.amount <= 0n) throw new Error("deposit amount must be positive");
    if (input.tokenDigest === "0x0") throw new Error("deposit token digest is empty");
    if (input.commitment === "0x0") throw new Error("deposit commitment is empty");

    const commitment = circuitMarginCommitment({
      amount: input.amount,
      assetDigest: input.tokenDigest,
      blinding: input.blinding,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.rhoDigest,
      spendSecretDigest: "0x0",
    });
    if (commitment !== input.commitment) {
      throw new Error("deposit note commitment mismatch");
    }

    const publicInputs = publicInputDigest("deposit-note", [
      input.amount,
      input.tokenDigest,
      input.commitment,
    ]);
    const artifact = buildProofArtifact(this.root, "deposit-note", {
      name: artifactName("deposit-note", [input.tokenDigest, input.commitment, input.amount]),
      inputs: {
        amount: input.amount,
        token_digest: field(input.tokenDigest),
        commitment: field(input.commitment),
        owner_digest: field(input.ownerDigest),
        rho_digest: field(input.rhoDigest),
        blinding: field(input.blinding),
        zero_commitment: 0n,
      },
    });

    const proof = this.bindArtifact("deposit-note", publicInputs, artifact);

    return {
      amount: input.amount,
      commitment: input.commitment,
      tokenDigest: input.tokenDigest,
      proof,
    };
  }

  proveSecureDepositNote(input: SecureDepositNoteWitness): DepositNoteRecord {
    if (input.amount <= 0n) throw new Error("deposit amount must be positive");
    if (secureMarginCommitment({
      amount: input.amount,
      assetDigest: input.tokenDigest,
      blinding: input.blinding,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.rhoDigest,
      spendSecretDigest: input.spendSecretDigest,
    }) !== input.commitment) {
      throw new Error("secure deposit note commitment mismatch");
    }
    const circuitId = "secure-deposit-note";
    const publicInputs = publicInputDigest(circuitId, [
      input.amount, input.tokenDigest, input.commitment,
    ]);
    const artifact = buildProofArtifact(this.root, circuitId, {
      name: artifactName(circuitId, [input.tokenDigest, input.commitment, input.amount]),
      inputs: {
        amount: input.amount,
        token_digest: field(input.tokenDigest),
        commitment: field(input.commitment),
        owner_digest: field(input.ownerDigest),
        rho_digest: field(input.rhoDigest),
        blinding: field(input.blinding),
        spend_secret_digest: field(input.spendSecretDigest),
      },
    });
    return {
      amount: input.amount,
      commitment: input.commitment,
      tokenDigest: input.tokenDigest,
      proof: this.bindArtifact(circuitId, publicInputs, artifact),
    };
  }

  proveIntentValidity(input: IntentValidityProofInput): IntentValidityRecord {
    const plan = intentValidityProofPlan(input);
    const artifact = buildProofArtifact(this.root, "intent-validity", plan.artifactOptions);
    return this.recordIntentValidity(plan, artifact);
  }

  async proveIntentValidityAsync(input: IntentValidityProofInput): Promise<IntentValidityRecord> {
    const plan = intentValidityProofPlan(input);
    const artifact = await buildProofArtifactAsync(this.root, "intent-validity", plan.artifactOptions);
    return this.recordIntentValidity(plan, artifact);
  }

  private recordIntentValidity(
    plan: IntentValidityProofPlan,
    artifact: ProofArtifact,
  ): IntentValidityRecord {
    const proof = this.bindArtifact("intent-validity", plan.publicInputs, artifact);
    const record = { ...plan.record, proof };
    this.intentValidityRecords.set(proofKey(proof), record);
    return record;
  }

  proveConditionalClose(input: ConditionalCloseProofInput): ConditionalOrderRecord {
    const plan = this.conditionalCloseProofPlan(input);
    const artifact = buildProofArtifact(this.root, "conditional-close", plan.artifactOptions);
    return { ...plan.record, proof: this.bindArtifact("conditional-close", plan.publicInputs, artifact) };
  }

  async proveConditionalCloseAsync(input: ConditionalCloseProofInput): Promise<ConditionalOrderRecord> {
    const plan = this.conditionalCloseProofPlan(input);
    const artifact = await buildProofArtifactAsync(this.root, "conditional-close", plan.artifactOptions);
    return { ...plan.record, proof: this.bindArtifact("conditional-close", plan.publicInputs, artifact) };
  }

  private conditionalCloseProofPlan(input: ConditionalCloseProofInput) {
    if (!input.reduceOnly) throw new Error("conditional close must be reduce-only");
    if (input.size <= 0n) throw new Error("close size must be positive");
    if (input.triggerPrice <= 0n) throw new Error("trigger price must be positive");
    if (input.markPrice <= 0n) throw new Error("mark price must be positive");
    if (!isConditionalCloseTriggered(input)) {
      throw new Error("conditional close not triggered");
    }

    const binding = conditionalOrderBindingFields(input);
    const closeCommitment = commitConditionalOrder(input);
    if (closeCommitment !== binding.closeCommitment) {
      throw new Error("conditional close commitment binding mismatch");
    }
    const publicInputs = publicInputDigest("conditional-close", [
      input.marketId,
      input.positionNullifier,
      closeCommitment,
      input.markPrice,
    ]);
    const artifactOptions: ProofArtifactOptions = {
      name: artifactName("conditional-close", [
        input.positionNullifier,
        closeCommitment,
        input.markPrice,
      ]),
      inputs: {
        is_long: input.side === "long",
        is_take_profit: input.kind === "take-profit",
        reduce_only: input.reduceOnly,
        market_digest: field(binding.marketDigest),
        trigger_price: input.triggerPrice,
        mark_price: input.markPrice,
        size: input.size,
        position_nullifier: field(input.positionNullifier),
        close_commitment: field(closeCommitment),
        salt_digest: field(binding.saltDigest),
        zero_value: 0n,
      },
    };
    return { artifactOptions, publicInputs, record: {
      marketId: input.marketId,
      markPrice: input.markPrice,
      positionNullifier: input.positionNullifier,
      closeCommitment,
    } };
  }

  proveWithdrawal(input: WithdrawalProofInput): WithdrawalRecord {
    if (input.noteAmount <= 0n) throw new Error("note amount must be positive");
    if (input.withdrawAmount <= 0n) throw new Error("withdraw amount must be positive");
    if (input.withdrawAmount > input.noteAmount) throw new Error("withdraw amount exceeds note");
    if (input.pathSiblings.length !== FIELD_MERKLE_DEPTH) {
      throw new Error("invalid withdrawal membership path");
    }
    if (input.pathIndices.length !== FIELD_MERKLE_DEPTH) {
      throw new Error("invalid withdrawal membership path");
    }

    const noteCommitment = circuitMarginCommitment({
      amount: input.noteAmount,
      assetDigest: input.assetDigest,
      blinding: input.blinding,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.rhoDigest,
      spendSecretDigest: input.spendSecretDigest,
    });
    if (noteCommitment !== input.noteCommitment) {
      throw new Error("withdrawal note commitment mismatch");
    }
    const noteNullifier = circuitNullifier({
      rhoDigest: input.rhoDigest,
      spendSecretDigest: input.spendSecretDigest,
    });
    if (noteNullifier !== input.nullifier) {
      throw new Error("withdrawal note nullifier mismatch");
    }

    const change = input.noteAmount - input.withdrawAmount;
    const tokenDigest = input.tokenDigest ?? input.assetDigest;
    if (tokenDigest !== input.assetDigest) {
      throw new Error("withdrawal token digest mismatch");
    }
    const changeCommitment =
      change === 0n
        ? "0x0"
        : circuitMarginCommitment({
            amount: change,
            assetDigest: input.assetDigest,
            blinding: requiredHex(input.changeBlinding, "changeBlinding"),
            ownerDigest: input.ownerDigest,
            rhoDigest: requiredHex(input.changeRhoDigest, "changeRhoDigest"),
            spendSecretDigest: input.spendSecretDigest,
          });

    const publicInputs = publicInputDigest("withdraw", [
      input.root,
      input.nullifier,
      tokenDigest,
      input.recipient,
      input.withdrawAmount,
      changeCommitment,
    ]);
    const artifact = buildProofArtifact(this.root, "withdraw", {
      name: artifactName("withdraw", [input.nullifier, input.withdrawAmount]),
      inputs: {
        note_amount: input.noteAmount,
        withdraw_amount: input.withdrawAmount,
        root: field(input.root),
        nullifier: field(input.nullifier),
        token_digest: field(tokenDigest),
        recipient_digest: field(input.recipient),
        change_commitment: field(changeCommitment),
        asset_digest: field(input.assetDigest),
        owner_digest: field(input.ownerDigest),
        rho_digest: field(input.rhoDigest),
        blinding: field(input.blinding),
        spend_secret_digest: field(input.spendSecretDigest),
        path_siblings: input.pathSiblings.map((sibling) => field(sibling)),
        path_indices: input.pathIndices,
        change_rho_digest: field(input.changeRhoDigest ?? "0x0"),
        change_blinding: field(input.changeBlinding ?? "0x0"),
        zero_value: 0n,
      },
    });

    const proof = this.bindArtifact("withdraw", publicInputs, artifact);

    return {
      root: input.root,
      nullifier: input.nullifier,
      recipient: input.recipient,
      tokenDigest,
      withdrawAmount: input.withdrawAmount,
      changeCommitment,
      proof,
    };
  }

  proveSecureWithdrawal(input: WithdrawalProofInput): WithdrawalRecord {
    if (input.noteAmount <= 0n || input.withdrawAmount <= 0n ||
      input.withdrawAmount > input.noteAmount) {
      throw new Error("invalid secure withdrawal amount");
    }
    if (input.pathSiblings.length !== POSITION_MERKLE_DEPTH ||
      input.pathIndices.length !== POSITION_MERKLE_DEPTH) {
      throw new Error("invalid secure withdrawal membership path");
    }
    if (secureMarginCommitment({
      amount: input.noteAmount,
      assetDigest: input.assetDigest,
      blinding: input.blinding,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.rhoDigest,
      spendSecretDigest: input.spendSecretDigest,
    }) !== input.noteCommitment ||
      secureMarginNullifier(input) !== input.nullifier) {
      throw new Error("secure withdrawal note opening mismatch");
    }
    const tokenDigest = input.tokenDigest ?? input.assetDigest;
    if (tokenDigest !== input.assetDigest) throw new Error("withdrawal token digest mismatch");
    const change = input.noteAmount - input.withdrawAmount;
    const changeCommitment = change === 0n ? ZERO_HEX : secureMarginCommitment({
      amount: change,
      assetDigest: input.assetDigest,
      blinding: requiredHex(input.changeBlinding, "changeBlinding"),
      ownerDigest: input.ownerDigest,
      rhoDigest: requiredHex(input.changeRhoDigest, "changeRhoDigest"),
      spendSecretDigest: input.spendSecretDigest,
    });
    const circuitId = "secure-withdraw";
    const publicInputs = publicInputDigest(circuitId, [
      input.withdrawAmount, input.root, input.nullifier, tokenDigest,
      input.recipient, changeCommitment,
    ]);
    const artifact = buildProofArtifact(this.root, circuitId, {
      name: artifactName(circuitId, [input.nullifier, input.withdrawAmount]),
      inputs: {
        note_amount: input.noteAmount,
        withdraw_amount: input.withdrawAmount,
        root: field(input.root),
        nullifier: field(input.nullifier),
        token_digest: field(tokenDigest),
        recipient_digest: field(input.recipient),
        change_commitment: field(changeCommitment),
        asset_digest: field(input.assetDigest),
        owner_digest: field(input.ownerDigest),
        rho_digest: field(input.rhoDigest),
        blinding: field(input.blinding),
        spend_secret_digest: field(input.spendSecretDigest),
        siblings: input.pathSiblings.map((sibling) => field(sibling)),
        indices: input.pathIndices,
        change_rho_digest: field(input.changeRhoDigest ?? ZERO_HEX),
        change_blinding: field(input.changeBlinding ?? ZERO_HEX),
        change_spend_secret_digest: field(change === 0n ? ZERO_HEX : input.spendSecretDigest),
      },
    });
    return {
      root: input.root,
      nullifier: input.nullifier,
      recipient: input.recipient,
      tokenDigest,
      withdrawAmount: input.withdrawAmount,
      changeCommitment,
      proof: this.bindArtifact(circuitId, publicInputs, artifact),
    };
  }

  proveLiquidation(input: LiquidationProofInput): LiquidationRecord {
    this.validatePositionOpening(input);
    const expectedFunding = input.size * (input.currentFundingIndex - input.fundingIndex) / PRICE_SCALE *
      (input.side === "long" ? 1n : -1n);
    if (input.fundingPayment !== expectedFunding) throw new Error("invalid funding payment");
    const funding = signedFundingWitness(input.fundingPayment);
    const liquidatable = isLiquidatable({
      side: input.side,
      size: input.size,
      entryPrice: input.entryPrice,
      markPrice: input.markPrice,
      margin: input.margin,
      fundingPayment: input.fundingPayment,
      maintenanceRate: input.maintenanceRate,
    });
    if (!liquidatable) throw new Error("position is healthy");

    const publicInputs = publicInputDigest("liquidation-check", [
      input.markPrice,
      input.maintenanceRate,
      PRICE_SCALE,
      RATE_SCALE,
      input.positionRoot,
      input.positionCommitment,
      input.positionNullifier,
      input.rewardCommitment,
      input.marketDigest,
      signedParts(input.currentFundingIndex).abs,
      signedParts(input.currentFundingIndex).isNegative,
    ]);
    const artifact = buildProofArtifact(this.root, "liquidation-check", {
      name: artifactName("liquidation", [input.positionNullifier, input.markPrice]),
      inputs: {
        is_long: input.side === "long",
        size: input.size,
        entry_price: input.entryPrice,
        mark_price: input.markPrice,
        margin: input.margin,
        funding_index: mod(input.fundingIndex),
        funding_index_abs: signedParts(input.fundingIndex).abs,
        funding_index_is_negative: signedParts(input.fundingIndex).isNegative,
        current_funding_index_abs: signedParts(input.currentFundingIndex).abs,
        current_funding_index_is_negative: signedParts(input.currentFundingIndex).isNegative,
        funding_payment_abs: funding.abs,
        funding_is_credit: funding.isCredit,
        maintenance_rate: input.maintenanceRate,
        price_scale: PRICE_SCALE,
        rate_scale: RATE_SCALE,
        position_root: field(input.positionRoot),
        position_commitment_public: field(input.positionCommitment),
        position_nullifier: field(input.positionNullifier),
        reward_commitment: field(input.rewardCommitment),
        market_digest: field(input.marketDigest),
        owner_digest: field(input.ownerDigest),
        rho_digest: field(input.rhoDigest),
        blinding: field(input.blinding),
        spend_secret_digest: field(input.spendSecretDigest),
        path_siblings: input.pathSiblings.map((sibling) => field(sibling)),
        path_indices: input.pathIndices,
        zero_value: 0n,
      },
    });

    const proof = this.bindArtifact("liquidation-check", publicInputs, artifact);

    return {
      marketId: input.marketId,
      currentFundingIndex: input.currentFundingIndex,
      markPrice: input.markPrice,
      maintenanceRate: input.maintenanceRate,
      positionCommitment: input.positionCommitment,
      positionNullifier: input.positionNullifier,
      positionRoot: input.positionRoot,
      rewardCommitment: input.rewardCommitment,
      proof,
    };
  }

  provePositionClosePair(
    inputs: [PositionCloseProofInput, PositionCloseProofInput], maintenanceRate: bigint, liquidation = false,
  ): PairedPositionCloseRecord {
    const plan = this.positionClosePairProofPlan(inputs, maintenanceRate, liquidation);
    const artifact = buildProofArtifact(this.root, "position-close-pair", plan.artifactOptions);
    return this.recordPositionClosePair(plan, artifact);
  }

  async provePositionClosePairAsync(
    inputs: [PositionCloseProofInput, PositionCloseProofInput], maintenanceRate: bigint, liquidation = false,
  ): Promise<PairedPositionCloseRecord> {
    const plan = this.positionClosePairProofPlan(inputs, maintenanceRate, liquidation);
    const artifact = await buildProofArtifactAsync(this.root, "position-close-pair", plan.artifactOptions);
    return this.recordPositionClosePair(plan, artifact);
  }

  private positionClosePairProofPlan(
    inputs: [PositionCloseProofInput, PositionCloseProofInput], maintenanceRate: bigint, liquidation: boolean,
  ): PositionClosePairProofPlan {
    inputs = inputs.map((input) => ({ ...input,
      pathSiblings: [...input.pathSiblings], pathIndices: [...input.pathIndices],
    })) as [PositionCloseProofInput, PositionCloseProofInput];
    const [first, second] = inputs;
    if (maintenanceRate <= 0n || maintenanceRate > RATE_SCALE) {
      throw new Error("invalid maintenance rate");
    }
    if (first.marketId !== second.marketId || first.marketDigest !== second.marketDigest ||
      first.markPrice !== second.markPrice || first.currentFundingIndex !== second.currentFundingIndex ||
      first.positionRoot !== second.positionRoot || first.size !== second.size ||
      first.entryPrice !== second.entryPrice || first.fundingIndex !== second.fundingIndex ||
      first.marginOutputAssetDigest !== second.marginOutputAssetDigest || first.side === second.side) {
      throw new Error("paired positions must have opposite sides and the same source economics");
    }
    if (field(first.marketDigest) !== field(hashFields("market-id", [first.marketId]))) {
      throw new Error("paired position market binding mismatch");
    }
    for (const key of ["positionCommitment", "positionNullifier", "closeCommitment",
      "newPositionCommitment", "marginOutputCommitment"] as const) {
      if (inputs[0][key] === inputs[1][key]) throw new Error("paired close inputs overlap");
    }
    const collateral = first.margin + second.margin;
    let distressed = false;
    for (const input of inputs) {
      this.validatePositionOpening(input);
      if (input.size <= 0n || input.closeSize !== input.size || input.entryPrice <= 0n ||
        input.markPrice <= 0n || input.margin < 0n || input.fee !== 0n || input.remainingMargin !== 0n) {
        throw new Error("invalid full paired close");
      }
      if (membershipRoot(input.positionCommitment, input.pathSiblings, input.pathIndices) !== input.positionRoot) {
        throw new Error("position root mismatch");
      }
      const pnl = input.size * (input.markPrice - input.entryPrice) / PRICE_SCALE *
        (input.side === "long" ? 1n : -1n);
      const funding = input.size * (input.currentFundingIndex - input.fundingIndex) / PRICE_SCALE *
        (input.side === "long" ? 1n : -1n);
      if (input.fundingPayment !== funding) throw new Error("invalid funding payment");
      const equity = input.margin + pnl - funding;
      const payout = equity < 0n ? 0n : equity > collateral ? collateral : equity;
      if (input.marginOutputAmount !== payout || input.newMargin !== payout) {
        throw new Error("invalid paired close payout");
      }
      const maintenance = input.size * input.markPrice / PRICE_SCALE * maintenanceRate / RATE_SCALE;
      distressed ||= equity <= 0n || equity < maintenance;
      if (input.newPositionCommitment !== circuitPositionCommitment({
        side: input.side, size: 0n, entryPrice: input.entryPrice, margin: 0n,
        fundingIndex: input.fundingIndex, marketDigest: input.marketDigest, ownerDigest: input.ownerDigest,
        rhoDigest: input.newPositionRhoDigest, blinding: input.newPositionBlinding,
        spendSecretDigest: input.spendSecretDigest,
      })) throw new Error("new position commitment mismatch");
      if (input.marginOutputCommitment !== secureMarginCommitment({
        amount: payout, assetDigest: input.marginOutputAssetDigest, ownerDigest: input.ownerDigest,
        rhoDigest: input.marginOutputRhoDigest, blinding: input.marginOutputBlinding,
        spendSecretDigest: input.marginOutputSpendSecretDigest,
      })) throw new Error("margin output commitment mismatch");
    }
    if (inputs[0].marginOutputAmount + inputs[1].marginOutputAmount !== collateral) {
      throw new Error("paired close does not conserve collateral");
    }
    if (liquidation && !distressed) throw new Error("position pair is not liquidatable");
    const current = signedParts(first.currentFundingIndex);
    const old = signedParts(first.fundingIndex);
    const publicInputs = publicInputDigest("position-close-pair", [first.marketDigest,
      first.marginOutputAssetDigest, first.markPrice, current.abs, current.isNegative,
      maintenanceRate, liquidation, first.positionRoot,
      ...inputs.map(input => input.positionCommitment), ...inputs.map(input => input.positionNullifier),
      ...inputs.map(input => input.closeCommitment), ...inputs.map(input => input.newPositionCommitment),
      ...inputs.map(input => input.marginOutputCommitment)]);
    const artifactOptions: ProofArtifactOptions = {
      name: artifactName("position-close-pair", [first.positionNullifier, second.positionNullifier, first.markPrice, liquidation]),
      inputs: {
        market_digest: field(first.marketDigest), asset_digest: field(first.marginOutputAssetDigest),
        mark_price: first.markPrice, current_funding_index_abs: current.abs,
        current_funding_index_is_negative: current.isNegative, maintenance_rate: maintenanceRate,
        liquidation, position_root: field(first.positionRoot),
        position_commitments: inputs.map(input => field(input.positionCommitment)),
        position_nullifiers: inputs.map(input => field(input.positionNullifier)),
        close_commitments: inputs.map(input => field(input.closeCommitment)),
        new_position_commitments: inputs.map(input => field(input.newPositionCommitment)),
        margin_output_commitments: inputs.map(input => field(input.marginOutputCommitment)),
        is_long: inputs.map(input => input.side === "long"), size: first.size,
        entry_price: first.entryPrice, funding_index: mod(first.fundingIndex),
        funding_index_abs: old.abs, funding_index_is_negative: old.isNegative,
        margins: inputs.map(input => input.margin), owner_digests: inputs.map(input => field(input.ownerDigest)),
        rhos: inputs.map(input => field(input.rhoDigest)), blindings: inputs.map(input => field(input.blinding)),
        spend_secret_digests: inputs.map(input => field(input.spendSecretDigest)),
        output_amounts: inputs.map(input => input.marginOutputAmount),
        new_position_rhos: inputs.map(input => field(input.newPositionRhoDigest)),
        new_position_blindings: inputs.map(input => field(input.newPositionBlinding)),
        output_rhos: inputs.map(input => field(input.marginOutputRhoDigest)),
        output_blindings: inputs.map(input => field(input.marginOutputBlinding)),
        output_spend_secrets: inputs.map(input => field(input.marginOutputSpendSecretDigest)),
        path_siblings: inputs.map(input => input.pathSiblings.map(field)),
        path_indices: inputs.map(input => input.pathIndices),
      },
    };
    return { inputs, maintenanceRate, liquidation, publicInputs, artifactOptions };
  }

  private recordPositionClosePair(plan: PositionClosePairProofPlan, artifact: ProofArtifact): PairedPositionCloseRecord {
    const { inputs, maintenanceRate, liquidation, publicInputs } = plan;
    const [first, second] = inputs;
    const proof = this.bindArtifact("position-close-pair", publicInputs, artifact);
    const positionRecord = (input: PositionCloseProofInput): PositionCloseRecord => ({
      marketId: input.marketId, markPrice: input.markPrice, currentFundingIndex: input.currentFundingIndex,
      positionRoot: input.positionRoot, positionCommitment: input.positionCommitment,
      positionNullifier: input.positionNullifier, closeCommitment: input.closeCommitment,
      newPositionCommitment: input.newPositionCommitment, marginOutputCommitment: input.marginOutputCommitment, proof,
    });
    return {marketId: first.marketId, markPrice: first.markPrice, assetDigest: first.marginOutputAssetDigest,
      currentFundingIndex: first.currentFundingIndex, maintenanceRate, liquidation,
      positionRoot: first.positionRoot, positions: [positionRecord(first), positionRecord(second)], proof};
  }

  provePositionClose(input: PositionCloseProofInput): PositionCloseRecord {
    this.validatePositionOpening(input);
    if (input.size <= 0n) throw new Error("position size must be positive");
    if (input.closeSize <= 0n) throw new Error("close size must be positive");
    if (input.closeSize !== input.size) throw new Error("position close must cover the full position");
    if (input.entryPrice <= 0n) throw new Error("entry price must be positive");
    if (input.markPrice <= 0n) throw new Error("mark price must be positive");
    if (input.fee !== 0n) throw new Error("close fee must be zero");
    const expectedFunding = input.size * (input.currentFundingIndex - input.fundingIndex) / PRICE_SCALE *
      (input.side === "long" ? 1n : -1n);
    if (input.fundingPayment !== expectedFunding) throw new Error("invalid funding payment");
    const funding = signedFundingWitness(input.fundingPayment);

    const settlement = settleClose({
      side: input.side,
      closeSize: input.closeSize,
      entryPrice: input.entryPrice,
      markPrice: input.markPrice,
      margin: input.margin,
      fundingPayment: input.fundingPayment,
      fee: input.fee,
    });
    if (input.newMargin !== settlement.newMargin) {
      throw new Error("invalid close settlement margin");
    }
    if (input.remainingMargin < 0n) throw new Error("remaining margin cannot be negative");
    if (input.marginOutputAmount < 0n) throw new Error("margin output amount cannot be negative");
    if (input.remainingMargin + input.marginOutputAmount !== input.newMargin) {
      throw new Error("invalid close margin split");
    }
    const remainingSize = input.size - input.closeSize;
    if (input.remainingMargin !== 0n) {
      throw new Error("closed position cannot retain margin");
    }
    const expectedNewPositionCommitment = circuitPositionCommitment({
      blinding: input.newPositionBlinding,
      entryPrice: input.entryPrice,
      fundingIndex: input.fundingIndex,
      margin: input.remainingMargin,
      marketDigest: input.marketDigest,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.newPositionRhoDigest,
      side: input.side,
      size: remainingSize,
      spendSecretDigest: input.spendSecretDigest,
    });
    if (input.newPositionCommitment !== expectedNewPositionCommitment) {
      throw new Error("new position commitment mismatch");
    }
    const expectedMarginOutputCommitment = secureMarginCommitment({
      amount: input.marginOutputAmount,
      assetDigest: input.marginOutputAssetDigest,
      blinding: input.marginOutputBlinding,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.marginOutputRhoDigest,
      spendSecretDigest: input.marginOutputSpendSecretDigest,
    });
    if (input.marginOutputCommitment !== expectedMarginOutputCommitment) {
      throw new Error("margin output commitment mismatch");
    }

    const publicInputs = publicInputDigest("position-close", [
      input.markPrice,
      PRICE_SCALE,
      input.positionRoot,
      input.positionCommitment,
      input.positionNullifier,
      input.closeCommitment,
      input.newPositionCommitment,
      input.marginOutputCommitment,
      input.marketDigest,
      signedParts(input.currentFundingIndex).abs,
      signedParts(input.currentFundingIndex).isNegative,
    ]);
    const artifact = buildProofArtifact(this.root, "position-close", {
      name: artifactName("position-close", [
        input.positionNullifier,
        input.closeCommitment,
        input.markPrice,
      ]),
      inputs: {
        is_long: input.side === "long",
        size: input.size,
        close_size: input.closeSize,
        entry_price: input.entryPrice,
        mark_price: input.markPrice,
        margin: input.margin,
        funding_index: mod(input.fundingIndex),
        funding_index_abs: signedParts(input.fundingIndex).abs,
        funding_index_is_negative: signedParts(input.fundingIndex).isNegative,
        current_funding_index_abs: signedParts(input.currentFundingIndex).abs,
        current_funding_index_is_negative: signedParts(input.currentFundingIndex).isNegative,
        funding_payment_abs: funding.abs,
        funding_is_credit: funding.isCredit,
        fee: input.fee,
        new_margin: input.newMargin,
        remaining_margin: input.remainingMargin,
        margin_output_amount: input.marginOutputAmount,
        price_scale: PRICE_SCALE,
        position_root: field(input.positionRoot),
        position_commitment_public: field(input.positionCommitment),
        position_nullifier: field(input.positionNullifier),
        close_commitment: field(input.closeCommitment),
        new_position_commitment: field(input.newPositionCommitment),
        margin_output_commitment: field(input.marginOutputCommitment),
        market_digest: field(input.marketDigest),
        owner_digest: field(input.ownerDigest),
        rho_digest: field(input.rhoDigest),
        blinding: field(input.blinding),
        spend_secret_digest: field(input.spendSecretDigest),
        new_position_rho_digest: field(input.newPositionRhoDigest),
        new_position_blinding: field(input.newPositionBlinding),
        margin_output_asset_digest: field(input.marginOutputAssetDigest),
        margin_output_rho_digest: field(input.marginOutputRhoDigest),
        margin_output_blinding: field(input.marginOutputBlinding),
        margin_output_spend_secret_digest: field(input.marginOutputSpendSecretDigest),
        path_siblings: input.pathSiblings.map((sibling) => field(sibling)),
        path_indices: input.pathIndices,
        zero_value: 0n,
      },
    });

    const proof = this.bindArtifact("position-close", publicInputs, artifact);

    return {
      marketId: input.marketId,
      currentFundingIndex: input.currentFundingIndex,
      markPrice: input.markPrice,
      positionCommitment: input.positionCommitment,
      positionNullifier: input.positionNullifier,
      positionRoot: input.positionRoot,
      closeCommitment: input.closeCommitment,
      newPositionCommitment: input.newPositionCommitment,
      marginOutputCommitment: input.marginOutputCommitment,
      proof,
    };
  }

  private validatePositionOpening(
    input: Pick<
      PositionCloseProofInput,
      | "blinding"
      | "entryPrice"
      | "fundingIndex"
      | "margin"
      | "marketDigest"
      | "ownerDigest"
      | "pathIndices"
      | "pathSiblings"
      | "positionCommitment"
      | "positionNullifier"
      | "rhoDigest"
      | "side"
      | "size"
      | "spendSecretDigest"
    >,
  ): void {
    if (input.pathSiblings.length !== POSITION_MERKLE_DEPTH) {
      throw new Error("invalid position membership path");
    }
    if (input.pathIndices.length !== POSITION_MERKLE_DEPTH) {
      throw new Error("invalid position membership path");
    }
    const positionCommitment = circuitPositionCommitment({
      blinding: input.blinding,
      entryPrice: input.entryPrice,
      fundingIndex: input.fundingIndex,
      margin: input.margin,
      marketDigest: input.marketDigest,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.rhoDigest,
      side: input.side,
      size: input.size,
      spendSecretDigest: input.spendSecretDigest,
    });
    if (positionCommitment !== input.positionCommitment) {
      throw new Error("position commitment mismatch");
    }
    const positionNullifier = circuitPositionNullifier({
      rhoDigest: input.rhoDigest,
      spendSecretDigest: input.spendSecretDigest,
    });
    if (positionNullifier !== input.positionNullifier) {
      throw new Error("position nullifier mismatch");
    }
  }

  proveDisclosure(input: DisclosureProofInput): DisclosureRecord {
    if (input.value > input.threshold) throw new Error("disclosure threshold exceeded");
    if (input.pathSiblings.length !== FIELD_MERKLE_DEPTH) {
      throw new Error("invalid disclosure membership path");
    }
    if (input.pathIndices.length !== FIELD_MERKLE_DEPTH) {
      throw new Error("invalid disclosure membership path");
    }

    const claimDigest = hashFields("disclosure-claim", [input.claim]);
    const disclosureCommitment = circuitDisclosureCommitment({
      claimDigest,
      saltDigest: input.saltDigest,
      subject: input.subject,
      value: input.value,
    });
    if (membershipRoot(disclosureCommitment, input.pathSiblings, input.pathIndices) !== input.root) {
      throw new Error("disclosure root mismatch");
    }
    const disclosureId = hashFields("disclosure-proof", [
      input.subject,
      claimDigest,
      input.root,
      input.salt,
    ]);
    const publicInputs = publicInputDigest("disclosure", [
      input.subject,
      claimDigest,
      input.root,
      input.threshold,
    ]);
    const artifact = buildProofArtifact(this.root, "disclosure", {
      name: artifactName("disclosure", [input.subject, claimDigest, input.root]),
      inputs: {
        value: input.value,
        threshold: input.threshold,
        subject: field(input.subject),
        claim_digest: field(claimDigest),
        root: field(input.root),
        salt_digest: field(input.saltDigest),
        path_siblings: input.pathSiblings.map((sibling) => field(sibling)),
        path_indices: input.pathIndices,
        zero_digest: 0n,
      },
    });

    const proof = this.bindArtifact("disclosure", publicInputs, artifact);

    return {
      disclosureId,
      subject: input.subject,
      claimDigest,
      root: input.root,
      threshold: input.threshold,
      proof,
    };
  }

  private bindArtifact(circuitId: Parameters<typeof loadCircuit>[1], publicInputs: Hex, artifact: ProofArtifact): ProofMeta {
    const proof = {
      ...bindProof(loadCircuit(this.root, circuitId), publicInputs, artifact),
      proofSystem: "noir-ultrahonk" as const,
    };
    this.artifacts.set(proofKey(proof), artifact);
    this.artifactRegistry.set(proof, artifact);
    return proof;
  }
}

interface IntentValidityProofPlan {
  artifactOptions: ProofArtifactOptions;
  publicInputs: Hex;
  record: Omit<IntentValidityRecord, "proof">;
}

function intentValidityProofPlan(input: IntentValidityProofInput): IntentValidityProofPlan {
  if (input.intent.size <= 0n) throw new Error("intent size must be positive");
  if (input.intent.margin <= 0n) throw new Error("intent margin must be positive");
  if (input.intent.limitPrice <= 0n) throw new Error("intent limit price must be positive");
  if (input.expiryBatch < input.currentBatch) throw new Error("intent expired");
  if (input.marginRoot === "0x0") throw new Error("margin root is empty");
  if (input.intent.noteNullifier === "0x0") throw new Error("note nullifier is empty");
  if (input.noteAmount < input.intent.margin) throw new Error("intent margin exceeds note");
  if (input.pathSiblings.length !== POSITION_MERKLE_DEPTH) {
    throw new Error("invalid margin membership path");
  }
  if (input.pathIndices.length !== POSITION_MERKLE_DEPTH) {
    throw new Error("invalid margin membership path");
  }

  const noteCommitment = secureMarginCommitment({
    amount: input.noteAmount,
    assetDigest: input.assetDigest,
    blinding: input.blinding,
    ownerDigest: input.ownerDigest,
    rhoDigest: input.rhoDigest,
    spendSecretDigest: input.spendSecretDigest,
  });
  if (noteCommitment !== input.noteCommitment) {
    throw new Error("margin note commitment mismatch");
  }
  const noteNullifier = secureMarginNullifier({
    rhoDigest: input.rhoDigest,
    spendSecretDigest: input.spendSecretDigest,
  });
  if (noteNullifier !== input.intent.noteNullifier) {
    throw new Error("margin note nullifier mismatch");
  }
  const noteChange = input.noteAmount - input.intent.margin;
  if (noteChange < 0n) throw new Error("intent margin exceeds note");
  if (noteChange === 0n) {
    if (input.noteChangeCommitment !== ZERO_HEX) {
      throw new Error("zero margin change must use zero commitment");
    }
  } else {
    if (input.changeRhoDigest === ZERO_HEX || input.changeBlinding === ZERO_HEX) {
      throw new Error("margin change opening is required");
    }
    const expectedChangeCommitment = secureMarginCommitment({
      amount: noteChange,
      assetDigest: input.assetDigest,
      blinding: input.changeBlinding,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.changeRhoDigest,
      spendSecretDigest: input.spendSecretDigest,
    });
    if (expectedChangeCommitment !== input.noteChangeCommitment) {
      throw new Error("margin change commitment mismatch");
    }
  }

  const binding = intentBindingFields(input.intent);
  const intentCommitment = commitIntent(input.intent);
  if (intentCommitment !== binding.intentCommitment) {
    throw new Error("intent commitment binding mismatch");
  }
  const positionSeed = derivePositionSeed(input.spendSecretDigest, binding.nonceDigest, binding.saltDigest);
  const matchingPayloadCommitment = circuitMatchingPayloadCommitment({
    intentCommitment, marketDigest: binding.marketDigest, ownerDigest: input.ownerDigest,
    signedSize: input.intent.side === "long" ? input.intent.size : -input.intent.size,
    limitPrice: input.intent.limitPrice, margin: input.intent.margin,
    noteNullifier: input.intent.noteNullifier, noteChangeCommitment: input.noteChangeCommitment, positionSeed,
  });
  const publicInputs = publicInputDigest("intent-validity", [
    input.assetDigest,
    input.currentBatch,
    binding.batchDigest,
    binding.marketDigest,
    intentCommitment,
    input.marginRoot,
    input.intent.noteNullifier,
    input.noteChangeCommitment,
    matchingPayloadCommitment,
  ]);
  return {
    artifactOptions: {
      name: artifactName("intent", [
        input.intent.batchId,
        input.intent.marketId,
        intentCommitment,
        input.marginRoot,
      ]),
      inputs: {
        size: input.intent.size,
        margin: input.intent.margin,
        limit_price: input.intent.limitPrice,
        is_long: input.intent.side === "long",
        expiry_batch: input.expiryBatch,
        note_amount: input.noteAmount,
        asset_digest: field(input.assetDigest),
        owner_digest: field(input.ownerDigest),
        rho_digest: field(input.rhoDigest),
        blinding: field(input.blinding),
        spend_secret_digest: field(input.spendSecretDigest),
        path_siblings: input.pathSiblings.map((sibling) => field(sibling)),
        path_indices: input.pathIndices,
        current_batch: input.currentBatch,
        batch_digest: field(binding.batchDigest),
        market_digest: field(binding.marketDigest),
        owner_commitment_field: field(binding.ownerCommitmentField),
        intent_commitment: field(intentCommitment),
        margin_root: field(input.marginRoot),
        note_commitment_public: field(input.noteCommitment),
        note_nullifier: field(input.intent.noteNullifier),
        note_change_commitment: field(input.noteChangeCommitment),
        nonce_digest: field(binding.nonceDigest),
        salt_digest: field(binding.saltDigest),
        change_rho_digest: field(input.changeRhoDigest),
        change_blinding: field(input.changeBlinding),
        zero_commitment: 0n,
        position_seed: field(positionSeed),
        matching_payload_commitment: field(matchingPayloadCommitment),
      },
    },
    publicInputs,
    record: {
      assetDigest: input.assetDigest,
      ownerDigest: input.ownerDigest,
      positionSeed,
      matchingPayloadCommitment,
      batchDigest: binding.batchDigest,
      currentBatch: input.currentBatch,
      expiryBatch: input.expiryBatch,
      intentCommitment,
      marketDigest: binding.marketDigest,
      noteChangeCommitment: input.noteChangeCommitment,
      noteCommitment: input.noteCommitment,
      marginRoot: input.marginRoot,
      noteNullifier: input.intent.noteNullifier,
      ownerCommitmentField: binding.ownerCommitmentField,
    },
  };
}

function assertFileHash(path: string, expected: Hex, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} not found`);
  if (fileHash(path) !== expected) throw new Error(`${label} hash mismatch`);
}

function fileHash(path: string): Hex {
  return `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function field(value: Hex): Hex {
  return `0x${mod(BigInt(value)).toString(16)}`;
}

function membershipRoot(leaf: Hex, siblings: Hex[], indices: boolean[]): Hex {
  let current = leaf;
  for (let i = 0; i < siblings.length; i += 1) {
    current = indices[i]
      ? fieldHashPair(siblings[i], current)
      : fieldHashPair(current, siblings[i]);
  }
  return current;
}

function requiredHex(value: Hex | undefined, fieldName: string): Hex {
  if (!value) throw new Error(`${fieldName} is required when withdrawal creates change`);
  return value;
}

function signedFundingWitness(payment: bigint): { abs: bigint; isCredit: boolean } {
  return payment < 0n
    ? { abs: -payment, isCredit: true }
    : { abs: payment, isCredit: false };
}

function signedParts(value: bigint): { abs: bigint; isNegative: boolean } {
  return value < 0n
    ? { abs: -value, isNegative: true }
    : { abs: value, isNegative: false };
}

function isConditionalCloseTriggered(input: ConditionalCloseProofInput): boolean {
  if (input.side === "long") {
    return input.kind === "take-profit"
      ? input.markPrice >= input.triggerPrice
      : input.markPrice <= input.triggerPrice;
  }

  return input.kind === "take-profit"
    ? input.markPrice <= input.triggerPrice
    : input.markPrice >= input.triggerPrice;
}

function artifactName(prefix: string, fields: unknown[]): string {
  return `${prefix}-${hashFields("proof-artifact", fields).slice(2, 18)}`;
}
