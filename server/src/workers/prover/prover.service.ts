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
} from "@pnlx/crypto";
import { isLiquidatable, PRICE_SCALE, RATE_SCALE, settleClose } from "@pnlx/market-math";
import {
  bindProof,
  buildProofArtifact,
  circuitKey,
  loadCircuit,
  publicInputDigest,
  type ProofArtifact,
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
  ProofMeta,
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

  proveIntentValidity(input: IntentValidityProofInput): IntentValidityRecord {
    if (input.intent.size <= 0n) throw new Error("intent size must be positive");
    if (input.intent.margin <= 0n) throw new Error("intent margin must be positive");
    if (input.intent.limitPrice <= 0n) throw new Error("intent limit price must be positive");
    if (input.expiryBatch < input.currentBatch) throw new Error("intent expired");
    if (input.marginRoot === "0x0") throw new Error("margin root is empty");
    if (input.intent.noteNullifier === "0x0") throw new Error("note nullifier is empty");
    if (input.noteAmount < input.intent.margin) throw new Error("intent margin exceeds note");
    if (input.pathSiblings.length !== FIELD_MERKLE_DEPTH) {
      throw new Error("invalid margin membership path");
    }
    if (input.pathIndices.length !== FIELD_MERKLE_DEPTH) {
      throw new Error("invalid margin membership path");
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
      throw new Error("margin note commitment mismatch");
    }
    const noteNullifier = circuitNullifier({
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
      const expectedChangeCommitment = circuitMarginCommitment({
        amount: noteChange,
        assetDigest: input.assetDigest,
        blinding: input.changeBlinding,
        ownerDigest: input.ownerDigest,
        rhoDigest: input.changeRhoDigest,
        spendSecretDigest: ZERO_HEX,
      });
      if (expectedChangeCommitment !== input.noteChangeCommitment) {
        console.error("DEBUG: expectedChangeCommitment Mismatch!", {
          noteChange: noteChange.toString(),
          assetDigest: input.assetDigest,
          changeBlinding: input.changeBlinding,
          ownerDigest: input.ownerDigest,
          changeRhoDigest: input.changeRhoDigest,
          expectedChangeCommitment,
          providedChangeCommitment: input.noteChangeCommitment,
        });
        throw new Error("margin change commitment mismatch");
      }
    }

    const binding = intentBindingFields(input.intent);
    const intentCommitment = commitIntent(input.intent);
    if (intentCommitment !== binding.intentCommitment) {
      throw new Error("intent commitment binding mismatch");
    }
    const publicInputs = publicInputDigest("intent-validity", [
      input.currentBatch,
      binding.batchDigest,
      binding.marketDigest,
      binding.ownerCommitmentField,
      intentCommitment,
      input.marginRoot,
      input.noteCommitment,
      input.intent.noteNullifier,
      input.noteChangeCommitment,
    ]);
    const artifact = buildProofArtifact(this.root, "intent-validity", {
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
      },
    });

    const proof = this.bindArtifact("intent-validity", publicInputs, artifact);
    const record = {
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
      proof,
    };
    this.intentValidityRecords.set(proofKey(proof), record);
    return record;
  }

  proveConditionalClose(input: ConditionalCloseProofInput): ConditionalOrderRecord {
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
    const artifact = buildProofArtifact(this.root, "conditional-close", {
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
    });

    const proof = this.bindArtifact("conditional-close", publicInputs, artifact);

    return {
      marketId: input.marketId,
      markPrice: input.markPrice,
      positionNullifier: input.positionNullifier,
      closeCommitment,
      proof,
    };
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

  proveLiquidation(input: LiquidationProofInput): LiquidationRecord {
    this.validatePositionOpening(input);
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
    ]);
    const artifact = buildProofArtifact(this.root, "liquidation-check", {
      name: artifactName("liquidation", [input.positionNullifier, input.markPrice]),
      inputs: {
        is_long: input.side === "long",
        size: input.size,
        entry_price: input.entryPrice,
        mark_price: input.markPrice,
        margin: input.margin,
        funding_index: input.fundingIndex,
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
      markPrice: input.markPrice,
      maintenanceRate: input.maintenanceRate,
      positionCommitment: input.positionCommitment,
      positionNullifier: input.positionNullifier,
      positionRoot: input.positionRoot,
      rewardCommitment: input.rewardCommitment,
      proof,
    };
  }

  provePositionClose(input: PositionCloseProofInput): PositionCloseRecord {
    this.validatePositionOpening(input);
    if (input.size <= 0n) throw new Error("position size must be positive");
    if (input.closeSize <= 0n) throw new Error("close size must be positive");
    if (input.closeSize > input.size) throw new Error("close size exceeds position");
    if (input.entryPrice <= 0n) throw new Error("entry price must be positive");
    if (input.markPrice <= 0n) throw new Error("mark price must be positive");
    if (input.fee < 0n) throw new Error("fee cannot be negative");
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
    if (remainingSize === 0n && input.remainingMargin !== 0n) {
      throw new Error("closed position cannot retain margin");
    }
    if (remainingSize > 0n && input.remainingMargin <= 0n) {
      throw new Error("residual position margin must be positive");
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
    const expectedMarginOutputCommitment = circuitMarginCommitment({
      amount: input.marginOutputAmount,
      assetDigest: input.marginOutputAssetDigest,
      blinding: input.marginOutputBlinding,
      ownerDigest: input.ownerDigest,
      rhoDigest: input.marginOutputRhoDigest,
      spendSecretDigest: "0x0",
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
        funding_index: input.fundingIndex,
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
        path_siblings: input.pathSiblings.map((sibling) => field(sibling)),
        path_indices: input.pathIndices,
        zero_value: 0n,
      },
    });

    const proof = this.bindArtifact("position-close", publicInputs, artifact);

    return {
      marketId: input.marketId,
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
