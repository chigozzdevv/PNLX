import { hashFields } from "@pnlx/crypto";
import type {
  BatchSettlement,
  ConditionalOrderCommitment,
  ConditionalOrderRecord,
  AssetWithdrawalRecord,
  DisclosureRecord,
  Hex,
  FundingSettlementRecord,
  IntentRecord,
  LiquidationRecord,
  MarketConfig,
  PositionCloseRecord,
  ProofMeta,
  WithdrawalRecord,
} from "@pnlx/protocol-types";
import type { RelayerService } from "@/workers/relayer/relayer.service";
import { parseOnchainMarketPrice } from "@/workers/oracle/oracle.service";
import type {
  DeploymentRegistry,
  OnchainRelay,
  OnchainRelayConfig,
  OnchainMarketConfig,
  OnchainRelayResult,
  OraclePriceRelayInput,
  ProofArtifactLocation,
  AssetDepositRelayInput,
  PreparedOnchainAction,
} from "@/workers/onchain/onchain.model";

type RelayKind =
  | "deposit"
  | "intent"
  | "market"
  | "oracle-price"
  | "batch-settlement"
  | "withdraw"
  | "conditional-order"
  | "conditional-close"
  | "position-close"
  | "liquidation"
  | "disclosure"
  | "funding-settlement"
  | "contract-invoke";

export class OnchainRelayService implements OnchainRelay {
  constructor(
    private readonly relayer: RelayerService,
    private readonly config: OnchainRelayConfig,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  deposit(commitment: Hex): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invoke("deposit", "shielded-pool", "deposit", [
          "--commitment",
          bytes32(commitment),
        ]),
      ],
    };
  }

  depositAsset(input: AssetDepositRelayInput): OnchainRelayResult {
    if (!this.config.enabled) throw new Error("asset deposit requires on-chain relay");
    this.validateDepositProof(input);
    return {
      relays: [
        this.invokeProofVerifier(input.depositProof.proof),
        this.invokePayload("deposit", this.depositAssetPayload(input)),
      ],
    };
  }

  verifyProof(proof: ProofMeta): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [this.invokeProofVerifier(proof)],
    };
  }

  prepareDepositAsset(input: AssetDepositRelayInput): PreparedOnchainAction {
    if (!this.config.enabled) throw new Error("asset deposit requires on-chain relay");
    this.validateDepositProof(input);
    const payload = this.depositAssetPayload(
      {
        ...input,
        autoSign: false,
        source: input.source ?? input.from,
      },
      true,
    );
    const prepared = this.relayer.prepareXdr({ kind: "deposit", payload });
    return {
      command: prepared.command,
      commandOutputDigest: prepared.commandOutputDigest,
      commandStatus: prepared.commandStatus,
      contractId: payload.contractId,
      functionName: payload.functionName,
      kind: "deposit",
      payload,
      txHash: prepared.txHash,
      xdr: prepared.xdr,
    };
  }

  tokenDigest(token: string, source?: string): Hex {
    if (!this.config.enabled) throw new Error("asset token digest requires on-chain relay");
    if (!token) throw new Error("asset token digest requires token");
    const deployment = this.deployment();
    const result = this.relayer.read({
      kind: "contract-invoke",
      payload: {
        args: ["--token", token],
        contractId: contractId(deployment, "shielded-pool"),
        functionName: "token_digest",
        send: "no",
        source: source ?? deployment.source,
      },
    });
    return parseHex32(result.output, `token digest for ${token}`);
  }

  assetBalance(token: string, account: string, source?: string): bigint {
    if (!this.config.enabled) throw new Error("asset balance requires on-chain relay");
    if (!token) throw new Error("asset balance requires token");
    if (!account) throw new Error("asset balance requires account");
    const deployment = this.deployment();
    try {
      const result = this.relayer.read({
        kind: "contract-invoke",
        payload: {
          args: ["--id", account],
          contractId: token,
          functionName: "balance",
          send: "no",
          source: source ?? deployment.source,
        },
      });
      return parseInteger(result.output, `asset balance for ${account}`);
    } catch (error) {
      if (isStellarAssetTrustlineMissing(error)) {
        throw new Error("collateral trustline is missing for this wallet");
      }
      throw error;
    }
  }

  submitIntent(record: IntentRecord): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invoke("intent", "intent-registry", "submit", [
          "--batch_id",
          bytes32(batchKey(record.batchId)),
          "--market_id",
          marketKey(record.marketId),
          "--intent_commitment",
          bytes32(record.intentCommitment),
          "--matching_payload_commitment",
          bytes32(record.matchingPayloadCommitment),
        ]),
      ],
    };
  }

  cancelIntent(intentCommitment: Hex): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invoke("intent", "intent-registry", "cancel", [
          "--intent_commitment",
          bytes32(intentCommitment),
        ]),
      ],
    };
  }

  isIntentRegistered(intentCommitment: Hex): boolean {
    if (!this.config.enabled) return false;
    const deployment = this.deployment();
    const result = this.relayer.read({
      kind: "intent",
      payload: {
        args: [
          "--intent_commitment",
          bytes32(intentCommitment),
        ],
        contractId: contractId(deployment, "intent-registry"),
        functionName: "has_intent",
        send: "no",
      },
    });
    return result.output.trim().toLowerCase().includes("true");
  }

  isMarketActive(marketId: string): boolean {
    if (!this.config.enabled) return false;
    const deployment = this.deployment();
    try {
      const result = this.relayer.read({
        kind: "market",
        payload: {
          args: [
            "--market_id",
            marketKey(marketId),
          ],
          contractId: contractId(deployment, "market"),
          functionName: "is_active",
          send: "no",
        },
      });
      return result.output.trim().toLowerCase().includes("true");
    } catch {
      return false;
    }
  }

  upsertMarket(record: MarketConfig, config: OnchainMarketConfig): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    const deployment = this.deployment();
    const oracleContract = config.oracleContractId || contractId(deployment, "price-oracle");
    const isBeam = config.oracleKind === "beam";
    const isStellar = config.oracleAssetType === "stellar";
    const oracleAsset = isStellar ? config.oracleAssetAddress : config.oracleAssetSymbol;
    if (!oracleAsset) throw new Error(`missing oracle asset for ${record.marketId}`);
    if (isBeam && !config.oracleBeamFeeToken) {
      throw new Error("missing beam fee token for market relay");
    }

    const functionName = isBeam
      ? isStellar
        ? "upsert_beam_stellar"
        : "upsert_beam_other"
      : isStellar
        ? "upsert_stellar"
        : "upsert_other";
    const args = [
      "--market_id",
      marketKey(record.marketId),
      "--oracle_contract",
      oracleContract,
      "--oracle_asset",
      oracleAsset,
    ];
    if (isBeam) {
      args.push("--beam_fee_token", config.oracleBeamFeeToken!);
    } else {
      args.push("--oracle_kind", config.oracleKind);
    }
    args.push(
      "--oracle_max_age",
      String(config.oracleMaxAge),
      "--oracle_twap_records",
      String(config.oracleTwapRecords),
      "--price_decimals",
      String(config.priceDecimals),
      "--max_leverage",
      record.maxLeverage.toString(),
      "--initial_rate",
      record.initialMarginRate.toString(),
      "--maintenance_rate",
      record.maintenanceMarginRate.toString(),
      "--funding_index",
      record.fundingIndex.toString(),
      "--active",
      "true",
    );

    return {
      relays: [this.invoke("market", "market", functionName, args)],
    };
  }

  publishOraclePrice(input: OraclePriceRelayInput): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    const deployment = this.deployment();
    const oracleContract = input.oracleContractId || contractId(deployment, "price-oracle");
    const oracleAsset = input.assetType === "stellar" ? input.assetAddress : input.assetSymbol;
    if (!oracleAsset) throw new Error("missing oracle asset for price publish");

    if (input.publishMode === "admin") {
      return {
        relays: [
          this.invokePayload("oracle-price", {
            contractId: oracleContract,
            functionName: input.assetType === "stellar" ? "set_stellar_price" : "set_other_price",
            args: [
              "--admin",
              deployment.sourceAddress,
              "--asset",
              oracleAsset,
              "--price",
              input.price.toString(),
              "--timestamp",
              String(input.timestamp),
            ],
          }),
        ],
      };
    }

    if (input.publishers.length === 0) {
      throw new Error("committee oracle publish requires publishers");
    }

    return {
      relays: input.publishers.map((publisher) =>
        this.invokePayload("oracle-price", {
          contractId: oracleContract,
          functionName: input.assetType === "stellar" ? "submit_stellar_price" : "submit_other_price",
          source: publisher.source,
          args: [
            "--publisher",
            publisher.address,
            "--asset",
            oracleAsset,
            "--round",
            input.round,
            "--price",
            input.price.toString(),
            "--timestamp",
            String(input.timestamp),
          ],
        }),
      ),
    };
  }

  settleBatch(record: BatchSettlement): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invokeProofVerifier(record.proof),
        this.invoke("batch-settlement", "batch-settlement", "settle", [
          "--batch_id",
          bytes32(batchKey(record.batchId)),
          "--market_id",
          marketKey(record.marketId),
          "--old_root",
          bytes32(record.oldRoot),
          "--new_root",
          bytes32(record.newRoot),
          "--settlement_digest",
          bytes32(record.settlementDigest),
          "--proof",
          proofArg(record.proof),
          "--filled_intents",
          bytes32Vec(record.orderUpdates.map((update) => update.intentCommitment)),
          "--new_commitments",
          bytes32Vec(record.newCommitments),
          "--margin_change_commitments",
          bytes32Vec(record.marginChangeCommitments),
          "--spent_nullifiers",
          bytes32Vec(record.spentNullifiers),
          "--volume",
          record.aggregateVolume.toString(),
          "--residual",
          record.residualSize.toString(),
        ]),
      ],
    };
  }

  async settleBatchAsync(record: BatchSettlement): Promise<OnchainRelayResult> {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        await this.invokeProofVerifierAsync(record.proof),
        await this.invokeAsync("batch-settlement", "batch-settlement", "settle", [
          "--batch_id",
          bytes32(batchKey(record.batchId)),
          "--market_id",
          marketKey(record.marketId),
          "--old_root",
          bytes32(record.oldRoot),
          "--new_root",
          bytes32(record.newRoot),
          "--settlement_digest",
          bytes32(record.settlementDigest),
          "--proof",
          proofArg(record.proof),
          "--filled_intents",
          bytes32Vec(record.orderUpdates.map((update) => update.intentCommitment)),
          "--new_commitments",
          bytes32Vec(record.newCommitments),
          "--margin_change_commitments",
          bytes32Vec(record.marginChangeCommitments),
          "--spent_nullifiers",
          bytes32Vec(record.spentNullifiers),
          "--volume",
          record.aggregateVolume.toString(),
          "--residual",
          record.residualSize.toString(),
        ]),
      ],
    };
  }

  isBatchSettled(batchId: string, marketId: string): boolean {
    if (!this.config.enabled) return false;
    const deployment = this.deployment();
    const result = this.relayer.read({
      kind: "batch-settlement",
      payload: {
        args: [
          "--batch_id",
          bytes32(batchKey(batchId)),
          "--market_id",
          marketKey(marketId),
        ],
        contractId: contractId(deployment, "batch-settlement"),
        functionName: "is_settled",
        send: "no",
      },
    });
    return result.output.trim().toLowerCase().includes("true");
  }

  positionRoot(): Hex {
    if (!this.config.enabled) throw new Error("position root requires on-chain relay");
    const deployment = this.deployment();
    const result = this.relayer.read({
      kind: "batch-settlement",
      payload: {
        contractId: contractId(deployment, "position-state"),
        functionName: "current_root",
        send: "no",
      },
    });
    return parseHex32(result.output, "position root");
  }

  settleFunding(record: FundingSettlementRecord): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invokeProofVerifier(record.proof),
        this.invoke("funding-settlement", "funding-settlement", "settle", [
          "--market_id",
          marketKey(record.marketId),
          "--old_index",
          record.oldFundingIndex.toString(),
          "--new_index",
          record.newFundingIndex.toString(),
          "--mark_price",
          record.markPrice.toString(),
          "--premium_rate",
          record.premiumRate.toString(),
          "--elapsed_ms",
          String(record.elapsedMs),
          "--interval_ms",
          String(record.intervalMs),
          "--max_delta",
          (record.maxFundingDelta ?? 0n).toString(),
          "--max_delta_enabled",
          record.maxFundingDelta === undefined ? "false" : "true",
          "--proof",
          proofArg(record.proof),
        ]),
      ],
    };
  }

  registerConditionalOrder(record: ConditionalOrderCommitment): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invoke("conditional-order", "conditional-order", "register", [
          "--market_id",
          marketKey(record.marketId),
          "--position_nullifier",
          bytes32(record.positionNullifier),
          "--close_commitment",
          bytes32(record.closeCommitment),
        ]),
      ],
    };
  }

  triggerConditionalClose(record: ConditionalOrderRecord): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    this.assertCurrentMarketPrice(record.marketId, record.markPrice, "conditional close");
    const proofVerification = this.invokeProofVerifier(record.proof);
    this.assertCurrentMarketPrice(record.marketId, record.markPrice, "conditional close");
    return {
      relays: [
        proofVerification,
        this.invokeWithMarketPriceGuard("conditional-close", "conditional-order", "trigger", [
          "--market_id",
          marketKey(record.marketId),
          "--position_nullifier",
          bytes32(record.positionNullifier),
          "--close_commitment",
          bytes32(record.closeCommitment),
          "--mark_price",
          record.markPrice.toString(),
          "--proof",
          proofArg(record.proof),
        ], record.marketId, record.markPrice, "conditional close"),
      ],
    };
  }

  settlePositionClose(record: PositionCloseRecord): OnchainRelayResult {
    return this.settlePositionCloseWith(record, "settle");
  }

  settleManualPositionClose(record: PositionCloseRecord): OnchainRelayResult {
    return this.settlePositionCloseWith(record, "settle_manual");
  }

  private settlePositionCloseWith(
    record: PositionCloseRecord,
    functionName: "settle" | "settle_manual",
  ): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    this.assertCurrentMarketPrice(record.marketId, record.markPrice, "position close");
    const proofVerification = this.invokeProofVerifier(record.proof);
    this.assertCurrentMarketPrice(record.marketId, record.markPrice, "position close");
    return {
      relays: [
        proofVerification,
        this.invokeWithMarketPriceGuard("position-close", "position-close", functionName, [
          "--market_id",
          marketKey(record.marketId),
          "--position_root",
          bytes32(record.positionRoot),
          "--position_commitment",
          bytes32(record.positionCommitment),
          "--position_nullifier",
          bytes32(record.positionNullifier),
          "--close_commitment",
          bytes32(record.closeCommitment),
          "--mark_price",
          record.markPrice.toString(),
          "--new_position_commitment",
          bytes32(record.newPositionCommitment),
          "--new_position_root",
          bytes32(record.newPositionRoot),
          "--margin_output_commitment",
          bytes32(record.marginOutputCommitment),
          "--proof",
          proofArg(record.proof),
        ], record.marketId, record.markPrice, "position close"),
      ],
    };
  }

  withdraw(record: WithdrawalRecord): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invokeProofVerifier(record.proof),
        this.invoke("withdraw", "shielded-pool", "withdraw", [
          "--root",
          bytes32(record.root),
          "--nullifier",
          bytes32(record.nullifier),
          "--token_digest",
          bytes32(record.tokenDigest),
          "--recipient",
          bytes32(record.recipient),
          "--amount",
          record.withdrawAmount.toString(),
          "--proof",
          proofArg(record.proof),
          "--change_commitment",
          changeCommitmentArg(record.changeCommitment),
        ]),
      ],
    };
  }

  withdrawAsset(record: AssetWithdrawalRecord): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invokeProofVerifier(record.proof),
        this.invoke("withdraw", "shielded-pool", "withdraw_asset", [
          "--token",
          record.token,
          "--root",
          bytes32(record.root),
          "--nullifier",
          bytes32(record.nullifier),
          "--recipient",
          record.recipientAddress,
          "--amount",
          record.withdrawAmount.toString(),
          "--proof",
          proofArg(record.proof),
          "--change_commitment",
          changeCommitmentArg(record.changeCommitment),
        ]),
      ],
    };
  }

  liquidate(record: LiquidationRecord): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    this.assertCurrentMarketPrice(record.marketId, record.markPrice, "liquidation");
    const proofVerification = this.invokeProofVerifier(record.proof);
    this.assertCurrentMarketPrice(record.marketId, record.markPrice, "liquidation");
    return {
      relays: [
        proofVerification,
        this.invokeWithMarketPriceGuard("liquidation", "liquidation", "liquidate", [
          "--market_id",
          marketKey(record.marketId),
          "--position_root",
          bytes32(record.positionRoot),
          "--position_commitment",
          bytes32(record.positionCommitment),
          "--position_nullifier",
          bytes32(record.positionNullifier),
          "--mark_price",
          record.markPrice.toString(),
          "--maintenance_rate",
          record.maintenanceRate.toString(),
          "--proof",
          proofArg(record.proof),
          "--reward_commitment",
          bytes32(record.rewardCommitment),
        ], record.marketId, record.markPrice, "liquidation"),
      ],
    };
  }

  disclose(record: DisclosureRecord): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invokeProofVerifier(record.proof),
        this.invoke("disclosure", "disclosure-verifier", "verify", [
          "--disclosure_id",
          bytes32(record.disclosureId),
          "--subject",
          bytes32(record.subject),
          "--claim",
          bytes32(record.claimDigest),
          "--root",
          bytes32(record.root),
          "--threshold",
          record.threshold.toString(),
          "--proof",
          proofArg(record.proof),
        ]),
      ],
    };
  }

  private invokeProofVerifier(proof: ProofMeta) {
    if (proof.proofSystem === "risc0-groth16") {
      return this.invokeRisc0ProofVerifier(proof);
    }
    const artifact = this.artifactFor(proof);
    return this.invoke("contract-invoke", `${proof.circuitId}-proof-verifier`, "verify_and_record", [
      "--public_inputs-file-path",
      artifact.publicInputsPath,
      "--proof_bytes-file-path",
      artifact.proofPath,
      "--public_input_hash",
      bytes32(proof.publicInputHash),
      "--proof_digest",
      bytes32(proof.proofDigest),
    ], true);
  }

  private async invokeProofVerifierAsync(proof: ProofMeta) {
    if (proof.proofSystem === "risc0-groth16") {
      return this.invokeRisc0ProofVerifierAsync(proof);
    }
    const artifact = this.artifactFor(proof);
    return this.invokeAsync("contract-invoke", `${proof.circuitId}-proof-verifier`, "verify_and_record", [
      "--public_inputs-file-path",
      artifact.publicInputsPath,
      "--proof_bytes-file-path",
      artifact.proofPath,
      "--public_input_hash",
      bytes32(proof.publicInputHash),
      "--proof_digest",
      bytes32(proof.proofDigest),
    ], true);
  }

  private invokeRisc0ProofVerifier(proof: ProofMeta) {
    if (!proof.imageId || !proof.journalDigest || !proof.sealDigest) {
      throw new Error("missing RISC0 receipt metadata");
    }
    const expectedImageId = this.deployment().risc0BatchMatchImageId;
    if (!expectedImageId) {
      throw new Error("deployment is missing the RISC0 batch-match image id");
    }
    if (proof.imageId.toLowerCase() !== expectedImageId.toLowerCase()) {
      throw new Error("RISC0 batch-match image id does not match the deployment");
    }
    const artifact = this.artifactFor(proof);
    return this.invoke("contract-invoke", `${proof.circuitId}-risc0-verifier`, "verify_and_record", [
      "--seal-file-path",
      artifact.proofPath,
      "--image_id",
      bytes32(proof.imageId),
      "--journal_digest",
      bytes32(proof.journalDigest),
      "--proof_digest",
      bytes32(proof.sealDigest),
    ], true);
  }

  private async invokeRisc0ProofVerifierAsync(proof: ProofMeta) {
    if (!proof.imageId || !proof.journalDigest || !proof.sealDigest) {
      throw new Error("missing RISC0 receipt metadata");
    }
    const expectedImageId = this.deployment().risc0BatchMatchImageId;
    if (!expectedImageId) {
      throw new Error("deployment is missing the RISC0 batch-match image id");
    }
    if (proof.imageId.toLowerCase() !== expectedImageId.toLowerCase()) {
      throw new Error("RISC0 batch-match image id does not match the deployment");
    }
    const artifact = this.artifactFor(proof);
    return this.invokeAsync("contract-invoke", `${proof.circuitId}-risc0-verifier`, "verify_and_record", [
      "--seal-file-path",
      artifact.proofPath,
      "--image_id",
      bytes32(proof.imageId),
      "--journal_digest",
      bytes32(proof.journalDigest),
      "--proof_digest",
      bytes32(proof.sealDigest),
    ], true);
  }

  private artifactFor(proof: ProofMeta): ProofArtifactLocation {
    const artifact = this.config.resolveProofArtifact?.(proof);
    if (!artifact) {
      throw new Error(`missing proof artifact for ${proof.circuitId}:${proof.proofDigest}`);
    }
    return artifact;
  }

  private invoke(
    kind: RelayKind,
    contractName: string,
    functionName: string,
    args: string[],
    verifier = false,
  ) {
    return this.invokePayload(kind, {
      args,
      contractId: verifier
        ? verifierId(this.deployment(), contractName)
        : contractId(this.deployment(), contractName),
      functionName,
    });
  }

  private invokeAsync(
    kind: RelayKind,
    contractName: string,
    functionName: string,
    args: string[],
    verifier = false,
  ) {
    return this.invokePayloadAsync(kind, {
      args,
      contractId: verifier
        ? verifierId(this.deployment(), contractName)
        : contractId(this.deployment(), contractName),
      functionName,
    });
  }

  private invokeWithMarketPriceGuard(
    kind: RelayKind,
    contractName: string,
    functionName: string,
    args: string[],
    marketId: string,
    expectedPrice: bigint,
    operation: string,
  ) {
    try {
      return this.invoke(kind, contractName, functionName, args);
    } catch (error) {
      this.assertCurrentMarketPrice(marketId, expectedPrice, operation);
      throw error;
    }
  }

  private assertCurrentMarketPrice(
    marketId: string,
    expectedPrice: bigint,
    operation: string,
  ): void {
    const currentPrice = this.currentMarketPrice(marketId);
    if (currentPrice !== expectedPrice) {
      throw new Error(
        `${operation} mark price mismatch: proof ${expectedPrice}, on-chain ${currentPrice}`,
      );
    }
  }

  private currentMarketPrice(marketId: string): bigint {
    const deployment = this.deployment();
    const result = this.relayer.read({
      kind: "market",
      payload: {
        args: ["--market_id", marketKey(marketId)],
        contractId: contractId(deployment, "market"),
        functionName: "mark_price",
        send: "no",
      },
    });
    return parseOnchainMarketPrice(result.output).price;
  }

  private invokePayload(
    kind: RelayKind,
    payload: {
      args?: string[];
      autoSign?: boolean;
      buildOnly?: boolean;
      contractId: string;
      functionName: string;
      send?: "default" | "no" | "yes";
      source?: string;
    },
  ) {
    return this.relayer.relay({ kind, payload });
  }

  private invokePayloadAsync(
    kind: RelayKind,
    payload: {
      args?: string[];
      autoSign?: boolean;
      buildOnly?: boolean;
      contractId: string;
      functionName: string;
      send?: "default" | "no" | "yes";
      source?: string;
    },
  ) {
    return this.relayer.relayAsync({ kind, payload });
  }

  private depositAssetPayload(input: AssetDepositRelayInput, buildOnly = false) {
    if (input.amount <= 0n) throw new Error("asset deposit amount must be positive");
    if (!input.token) throw new Error("asset deposit token is required");
    if (!input.from) throw new Error("asset deposit source address is required");

    return {
      args: [
        "--token",
        input.token,
        "--from",
        input.from,
        "--amount",
        input.amount.toString(),
        "--commitment",
        bytes32(input.commitment),
        "--proof",
        proofArg(input.depositProof.proof),
      ],
      autoSign: input.autoSign,
      buildOnly,
      contractId: contractId(this.deployment(), "shielded-pool"),
      functionName: "deposit_asset",
      send: (buildOnly ? "no" : "yes") as "no" | "yes",
      source: input.source ?? input.from,
    };
  }

  private validateDepositProof(input: AssetDepositRelayInput): void {
    if (input.depositProof.amount !== input.amount) {
      throw new Error("asset deposit proof amount mismatch");
    }
    if (input.depositProof.commitment !== input.commitment) {
      throw new Error("asset deposit proof commitment mismatch");
    }
  }

  private deployment(): DeploymentRegistry {
    if (!this.config.deployment) {
      throw new Error("on-chain relay requires deployment registry");
    }
    return this.config.deployment;
  }
}

function empty(): OnchainRelayResult {
  return { relays: [] };
}

function contractId(deployment: DeploymentRegistry, name: string): string {
  const id = deployment.contracts[name];
  if (!id) throw new Error(`deployment missing contract: ${name}`);
  return id;
}

function verifierId(deployment: DeploymentRegistry, name: string): string {
  const id = deployment.verifiers[name];
  if (!id) throw new Error(`deployment missing verifier: ${name}`);
  return id;
}

function marketKey(marketId: string): string {
  return bytes32(hashFields("market-id", [marketId]));
}

function batchKey(batchId: string): Hex {
  return hashFields("batch-id", [batchId]);
}

function proofArg(proof: ProofMeta): string {
  return JSON.stringify({
    circuit_hash: bytes32(proof.circuitHash),
    circuit_id: bytes32(proof.circuitKey),
    proof_digest: bytes32(proof.proofDigest),
    public_input_hash: bytes32(proof.publicInputHash),
    verifier_hash: bytes32(proof.verifierHash),
  });
}

function changeCommitmentArg(commitment: Hex): string {
  return commitment === "0x0" ? "0".repeat(64) : bytes32(commitment);
}

function bytes32(value: Hex | string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function bytes32Vec(values: Array<Hex | string>): string {
  return JSON.stringify(values.map(bytes32));
}

function parseHex32(output: string, label: string): Hex {
  const match = output.match(/(?:0x)?([0-9a-fA-F]{64})/);
  if (!match) throw new Error(`${label} did not return bytes32`);
  return `0x${match[1].toLowerCase()}`;
}

function parseInteger(output: string, label: string): bigint {
  const match = output.match(/-?\d+/);
  if (!match) throw new Error(`${label} did not return integer`);
  return BigInt(match[0]);
}

function isStellarAssetTrustlineMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Contract, #13") ||
    message.includes("TrustlineMissingError") ||
    message.toLowerCase().includes("trustline is missing");
}
