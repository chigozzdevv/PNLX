import { hashFields, secureMarginRoot } from "@pnlx/crypto";
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
  PairedPositionCloseRecord,
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

  marketPrice(marketId: string): bigint {
    if (!this.config.enabled) throw new Error("on-chain relay is disabled");
    return this.currentMarketPrice(marketId);
  }

  async marketPriceAsync(marketId: string): Promise<bigint> {
    return (await this.marketPriceSnapshotAsync(marketId)).price;
  }

  marketFundingIndex(marketId: string): bigint {
    if (!this.config.enabled) throw new Error("on-chain relay is disabled");
    const result = this.relayer.read({kind:"market",payload:{
      contractId:contractId(this.deployment(),"market"),functionName:"funding_index",
      args:["--market_id",marketKey(marketId)],send:"no",
    }});
    const value = (result.stdout ?? result.output).trim().replace(/^"|"$/g, "");
    if (!/^-?\d+$/.test(value)) throw new Error("invalid on-chain funding index");
    return BigInt(value);
  }

  async marketFundingIndexAsync(marketId: string): Promise<bigint> {
    if (!this.config.enabled) throw new Error("on-chain relay is disabled");
    const result = await this.relayer.readAsync({ kind: "market", payload: {
      contractId: contractId(this.deployment(), "market"), functionName: "funding_index",
      args: ["--market_id", marketKey(marketId)], send: "no",
    } });
    const value = (result.stdout ?? result.output).trim().replace(/^"|"$/g, "");
    if (!/^-?\d+$/.test(value)) throw new Error("invalid on-chain funding index");
    return BigInt(value);
  }

  async marketPriceSnapshotAsync(marketId: string): Promise<{ price: bigint; timestamp: number }> {
    if (!this.config.enabled) throw new Error("on-chain relay is disabled");
    const result = await this.relayer.readAsync({
      kind: "market",
      payload: this.marketPriceReadPayload(marketId),
    });
    return parseOnchainMarketPrice(result.output);
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
        ...(source ? { source } : {}),
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
          ...(source ? { source } : {}),
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

  secureNoteSnapshot(cached: Hex[] = []): { commitments: Hex[]; root: Hex } {
    if (!this.config.enabled) throw new Error("secure notes require on-chain relay");
    const pool = contractId(this.deployment(), "shielded-pool");
    const read = (functionName: string, args: string[] = []) => this.relayer.read({
      kind: "contract-invoke",
      payload: { args, contractId: pool, functionName, send: "no" },
    }).output;
    const root = parseHex32(read("secure_note_root"), "secure note root");
    if (secureMarginRoot(cached) === root) return { commitments: [...cached], root };
    const count = Number(parseInteger(read("secure_note_count"), "secure note count"));
    if (!Number.isSafeInteger(count) || count < 0 || count > (1 << 20)) {
      throw new Error("invalid secure note count");
    }
    const appendFrom = (prefix: Hex[]) => {
      const commitments = [...prefix];
      for (let index = commitments.length; index < count; index += 1) {
        commitments.push(parseHex32(read("secure_note_leaf", ["--index", String(index)]),
          `secure note leaf ${index}`));
      }
      return commitments;
    };
    let commitments = cached.length <= count ? appendFrom(cached) : [];
    if (secureMarginRoot(commitments) !== root) commitments = appendFrom([]);
    if (secureMarginRoot(commitments) !== root) {
      throw new Error("on-chain secure note tree does not match its leaves");
    }
    return { commitments, root };
  }

  submitIntent(record: IntentRecord): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        this.invokeProofVerifier(record.proof),
        this.invoke("intent", "intent-registry", "submit", [
          "--batch_id",
          bytes32(batchKey(record.batchId)),
          "--market_id",
          marketKey(record.marketId),
          "--intent_commitment",
          bytes32(record.intentCommitment),
          "--matching_payload_commitment",
          bytes32(record.matchingPayloadCommitment),
          "--margin_root",
          bytes32(record.marginRoot),
          "--note_nullifier",
          bytes32(record.noteNullifier),
          "--current_batch", record.currentBatch.toString(),
          "--note_change_commitment", bytes32(record.noteChangeCommitment),
          "--proof", proofArg(record.proof),
        ]),
      ],
    };
  }

  async submitIntentAsync(record: IntentRecord): Promise<OnchainRelayResult> {
    if (!this.config.enabled) return empty();
    return {
      relays: [
        await this.invokeProofVerifierAsync(record.proof),
        await this.invokeAsync("intent", "intent-registry", "submit", [
          "--batch_id",
          bytes32(batchKey(record.batchId)),
          "--market_id",
          marketKey(record.marketId),
          "--intent_commitment",
          bytes32(record.intentCommitment),
          "--matching_payload_commitment",
          bytes32(record.matchingPayloadCommitment),
          "--margin_root",
          bytes32(record.marginRoot),
          "--note_nullifier",
          bytes32(record.noteNullifier),
          "--current_batch", record.currentBatch.toString(),
          "--note_change_commitment", bytes32(record.noteChangeCommitment),
          "--proof", proofArg(record.proof),
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

  async cancelIntentAsync(intentCommitment: Hex): Promise<OnchainRelayResult> {
    if (!this.config.enabled) return empty();
    return { relays: [await this.invokeAsync("intent", "intent-registry", "cancel", [
      "--intent_commitment", bytes32(intentCommitment),
    ])] };
  }

  residualMargin(intentCommitment: Hex): bigint {
    if (!this.config.enabled) throw new Error("residual claim requires on-chain relay");
    const result = this.relayer.read({
      kind: "batch-settlement",
      payload: {
        args: ["--intent_commitment", bytes32(intentCommitment)],
        contractId: contractId(this.deployment(), "batch-settlement"),
        functionName: "residual_margin",
        send: "no",
      },
    });
    return parseInteger(result.output, "residual margin");
  }

  claimedResidual(intentCommitment: Hex): Hex | undefined {
    if (!this.config.enabled) throw new Error("residual claim requires on-chain relay");
    const result = this.relayer.read({
      kind: "batch-settlement",
      payload: {
        args: ["--intent_commitment", bytes32(intentCommitment)],
        contractId: contractId(this.deployment(), "batch-settlement"),
        functionName: "claimed_residual",
        send: "no",
      },
    });
    if (/^\s*(?:null|none)\s*$/i.test(result.output)) return undefined;
    return parseHex32(result.output, "claimed residual");
  }

  claimResidual(intentCommitment: Hex, commitment: Hex, proof: ProofMeta): OnchainRelayResult {
    if (!this.config.enabled) throw new Error("residual claim requires on-chain relay");
    return {
      relays: [this.invoke("batch-settlement", "batch-settlement", "claim_residual", [
        "--intent_commitment", bytes32(intentCommitment),
        "--commitment", bytes32(commitment),
        "--proof", proofArg(proof),
      ])],
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
    return parseStrictBoolean(result.stdout ?? result.output, "intent registration status");
  }

  intentSubmissionSequence(intentCommitment: Hex): bigint {
    if (!this.config.enabled) throw new Error("intent sequence requires on-chain relay");
    const result = this.relayer.read({
      kind: "intent",
      payload: {
        args: ["--intent_commitment", bytes32(intentCommitment)],
        contractId: contractId(this.deployment(), "intent-registry"),
        functionName: "submission_sequence",
        send: "no",
      },
    });
    const sequence = parseInteger(result.output, "intent submission sequence");
    if (sequence <= 0n) throw new Error("intent submission sequence unavailable");
    return sequence;
  }

  async intentSubmissionSequenceAsync(intentCommitment: Hex): Promise<bigint> {
    if (!this.config.enabled) throw new Error("intent sequence requires on-chain relay");
    const result = await this.relayer.readAsync({
      kind: "intent",
      payload: {
        args: ["--intent_commitment", bytes32(intentCommitment)],
        contractId: contractId(this.deployment(), "intent-registry"),
        functionName: "submission_sequence",
        send: "no",
      },
    });
    const sequence = parseInteger(result.output, "intent submission sequence");
    if (sequence <= 0n) throw new Error("intent submission sequence unavailable");
    return sequence;
  }

  async isIntentRegisteredAsync(intentCommitment: Hex): Promise<boolean> {
    if (!this.config.enabled) return false;
    const deployment = this.deployment();
    const result = await this.relayer.readAsync({
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
    return parseStrictBoolean(result.stdout ?? result.output, "intent registration status");
  }

  async isIntentActiveAsync(intentCommitment: Hex): Promise<boolean> {
    if (!this.config.enabled) throw new Error("intent status requires on-chain relay");
    const result = await this.relayer.readAsync({ kind: "intent", payload: {
      args: ["--intent_commitment", bytes32(intentCommitment)],
      contractId: contractId(this.deployment(), "intent-registry"), functionName: "is_active_intent", send: "no",
    } });
    return parseAuthoritativeBoolean(result.stdout, "intent active status");
  }

  async isIntentCancelledAsync(intentCommitment: Hex): Promise<boolean> {
    if (!this.config.enabled) throw new Error("intent cancellation status requires on-chain relay");
    const result = await this.relayer.readAsync({ kind: "intent", payload: {
      args: ["--intent_commitment", bytes32(intentCommitment)],
      contractId: contractId(this.deployment(), "intent-registry"), functionName: "is_cancelled", send: "no",
    } });
    return parseAuthoritativeBoolean(result.stdout, "intent cancellation status");
  }

  async intentMatchingPayloadCommitmentAsync(intentCommitment: Hex): Promise<Hex> {
    if (!this.config.enabled) throw new Error("intent payload requires on-chain relay");
    const result = await this.relayer.readAsync({ kind: "intent", payload: {
      args: ["--intent_commitment", bytes32(intentCommitment)],
      contractId: contractId(this.deployment(), "intent-registry"), functionName: "matching_payload_commitment", send: "no",
    } });
    const payload = (result.stdout ?? result.output).trim().replace(/^"|"$/g, "");
    if (!/^(?:0x)?[0-9a-f]{64}$/i.test(payload)) throw new Error("invalid intent matching payload commitment");
    return `0x${payload.replace(/^0x/i, "").toLowerCase()}`;
  }

  async isSecureNullifierSpentAsync(noteNullifier: Hex): Promise<boolean> {
    if (!this.config.enabled) throw new Error("secure nullifier status requires on-chain relay");
    const result = await this.relayer.readAsync({ kind: "contract-invoke", payload: {
      args: ["--nullifier", bytes32(noteNullifier)],
      contractId: contractId(this.deployment(), "shielded-pool"), functionName: "is_spent", send: "no",
    } });
    return parseAuthoritativeBoolean(result.stdout, "secure nullifier status");
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

  async isMarketActiveAsync(marketId: string): Promise<boolean> {
    if (!this.config.enabled) return false;
    const deployment = this.deployment();
    try {
      const result = await this.relayer.readAsync({
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
    const { args, functionName } = marketUpsertInvocation(this.deployment(), record, config);

    return {
      relays: [this.invoke("market", "market", functionName, args)],
    };
  }

  async upsertMarketAsync(record: MarketConfig, config: OnchainMarketConfig, signal?: AbortSignal): Promise<OnchainRelayResult> {
    if (!this.config.enabled) return empty();
    const { args, functionName } = marketUpsertInvocation(this.deployment(), record, config);

    return {
      relays: [await this.invokeAsync("market", "market", functionName, args, false, signal)],
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

  async publishOraclePriceAsync(input: OraclePriceRelayInput): Promise<OnchainRelayResult> {
    if (!this.config.enabled) return empty();
    const deployment = this.deployment();
    const oracleContract = input.oracleContractId || contractId(deployment, "price-oracle");
    const oracleAsset = input.assetType === "stellar" ? input.assetAddress : input.assetSymbol;
    if (!oracleAsset) throw new Error("missing oracle asset for price publish");

    if (input.publishMode === "admin") {
      return {
        relays: [await this.invokePayloadAsync("oracle-price", {
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
        }, input.signal)],
      };
    }

    if (input.publishers.length === 0) {
      throw new Error("committee oracle publish requires publishers");
    }

    const relays = [];
    for (const publisher of input.publishers) {
      relays.push(await this.invokePayloadAsync("oracle-price", {
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
      }, input.signal));
    }
    return { relays };
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
          "--matching_payload_commitments",
          bytes32Vec(record.matchingPayloadCommitments),
          "--residual_commitments",
          bytes32Vec(record.residualCommitments),
          "--residual_payload_commitments",
          bytes32Vec(record.residualPayloadCommitments),
          "--residual_margins",
          JSON.stringify(record.residualMargins.map(String)),
          "--volume",
          record.aggregateVolume.toString(),
          "--residual",
          record.residualSize.toString(),
          "--fee_config_hash",
          bytes32(record.feeConfigHash),
          "--gross_taker_fee",
          record.grossTakerFee.toString(),
          "--maker_rebate",
          record.makerRebate.toString(),
          "--insurance_fee",
          record.insuranceFee.toString(),
          "--treasury_fee",
          record.treasuryFee.toString(),
          "--maker_intents",
          bytes32Vec(record.makerIntents),
          "--taker_intents",
          bytes32Vec(record.takerIntents),
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
          "--matching_payload_commitments",
          bytes32Vec(record.matchingPayloadCommitments),
          "--residual_commitments",
          bytes32Vec(record.residualCommitments),
          "--residual_payload_commitments",
          bytes32Vec(record.residualPayloadCommitments),
          "--residual_margins",
          JSON.stringify(record.residualMargins.map(String)),
          "--volume",
          record.aggregateVolume.toString(),
          "--residual",
          record.residualSize.toString(),
          "--fee_config_hash",
          bytes32(record.feeConfigHash),
          "--gross_taker_fee",
          record.grossTakerFee.toString(),
          "--maker_rebate",
          record.makerRebate.toString(),
          "--insurance_fee",
          record.insuranceFee.toString(),
          "--treasury_fee",
          record.treasuryFee.toString(),
          "--maker_intents",
          bytes32Vec(record.makerIntents),
          "--taker_intents",
          bytes32Vec(record.takerIntents),
        ]),
      ],
    };
  }

  isBatchSettled(batchId: string, marketId: string, settlementDigest?: Hex): boolean {
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
          ...(settlementDigest ? ["--settlement_digest", bytes32(settlementDigest)] : []),
        ],
        contractId: contractId(deployment, "batch-settlement"),
        functionName: settlementDigest ? "is_settled_digest" : "is_settled",
        send: "no",
      },
    });
    return strictBatchSettlementStatus(result.stdout);
  }

  async isBatchSettledAsync(batchId: string, marketId: string, settlementDigest?: Hex): Promise<boolean> {
    if (!this.config.enabled) return false;
    const deployment = this.deployment();
    const result = await this.relayer.readAsync({
      kind: "batch-settlement",
      payload: {
        args: [
          "--batch_id",
          bytes32(batchKey(batchId)),
          "--market_id",
          marketKey(marketId),
          ...(settlementDigest ? ["--settlement_digest", bytes32(settlementDigest)] : []),
        ],
        contractId: contractId(deployment, "batch-settlement"),
        functionName: settlementDigest ? "is_settled_digest" : "is_settled",
        send: "no",
      },
    });
    return strictBatchSettlementStatus(result.stdout);
  }

  async batchPositionAppendIndexAsync(batchId: string, marketId: string): Promise<number> {
    if (!this.config.enabled) throw new Error("batch append index requires on-chain relay");
    const result = await this.relayer.readAsync({
      kind: "batch-settlement",
      payload: {
        args: ["--batch_id", bytes32(batchKey(batchId)), "--market_id", marketKey(marketId)],
        contractId: contractId(this.deployment(), "batch-settlement"),
        functionName: "settlement_meta", send: "no",
      },
    });
    let metadata: unknown;
    try { metadata = JSON.parse(result.stdout ?? result.output); }
    catch { throw new Error("invalid batch settlement metadata"); }
    if (Array.isArray(metadata) && metadata.length === 1) metadata = metadata[0];
    if (metadata && typeof metadata === "object" && "Some" in metadata) metadata = (metadata as { Some: unknown }).Some;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("batch settlement metadata is missing");
    const raw = (metadata as Record<string, unknown>).first_position_index;
    const index = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) throw new Error("invalid batch position append index");
    return index;
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

  async positionRootAsync(): Promise<Hex> {
    if (!this.config.enabled) throw new Error("position root requires on-chain relay");
    const deployment = this.deployment();
    const result = await this.relayer.readAsync({
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

  async registerConditionalOrderAsync(record: ConditionalOrderCommitment): Promise<OnchainRelayResult> {
    if (!this.config.enabled) return empty();
    return { relays: [await this.invokeAsync("conditional-order", "conditional-order", "register", [
      "--market_id", marketKey(record.marketId), "--position_nullifier", bytes32(record.positionNullifier),
      "--close_commitment", bytes32(record.closeCommitment),
    ])] };
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

  async triggerConditionalCloseAsync(record: ConditionalOrderRecord): Promise<OnchainRelayResult> {
    if (!this.config.enabled) return empty();
    await this.assertCurrentMarketPriceAsync(record.marketId, record.markPrice, "conditional close");
    const proofVerification = await this.invokeProofVerifierAsync(record.proof);
    await this.assertCurrentMarketPriceAsync(record.marketId, record.markPrice, "conditional close");
    try {
      const trigger = await this.invokeAsync("conditional-close", "conditional-order", "trigger", [
        "--market_id", marketKey(record.marketId), "--position_nullifier", bytes32(record.positionNullifier),
        "--close_commitment", bytes32(record.closeCommitment), "--mark_price", record.markPrice.toString(),
        "--proof", proofArg(record.proof),
      ]);
      return { relays: [proofVerification, trigger] };
    } catch (error) {
      await this.assertCurrentMarketPriceAsync(record.marketId, record.markPrice, "conditional close");
      throw error;
    }
  }

  settlePositionClose(record: PositionCloseRecord): OnchainRelayResult {
    return this.settlePositionCloseWith(record, "settle");
  }

  settleManualPositionClose(record: PositionCloseRecord): OnchainRelayResult {
    return this.settlePositionCloseWith(record, "settle_manual");
  }

  settlePairedPositionClose(
    trader: PositionCloseRecord,
    maker: PositionCloseRecord,
    conditional: boolean,
  ): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    if (trader.marketId !== maker.marketId || trader.markPrice !== maker.markPrice ||
      trader.positionCommitment === maker.positionCommitment ||
      trader.positionNullifier === maker.positionNullifier) {
      throw new Error("paired position closes must use distinct positions and the same market mark");
    }
    this.assertCurrentMarketPrice(trader.marketId, trader.markPrice, "paired position close");
    const traderProof = this.invokeProofVerifier(trader.proof);
    const makerProof = this.invokeProofVerifier(maker.proof);
    this.assertCurrentMarketPrice(trader.marketId, trader.markPrice, "paired position close");
    return {
      relays: [traderProof, makerProof,
        this.invokeWithMarketPriceGuard("position-close", "position-close",
          conditional ? "settle_pair_conditional" : "settle_pair_manual", [
            "--trader", positionCloseArg(trader),
            "--maker", positionCloseArg(maker),
          ], trader.marketId, trader.markPrice, "paired position close")],
    };
  }

  settleProvenPositionPair(pair: PairedPositionCloseRecord, conditional: boolean): OnchainRelayResult {
    if (!this.config.enabled) return empty();
    if (pair.positions.some(position => position.marketId !== pair.marketId ||
      position.markPrice !== pair.markPrice || position.currentFundingIndex !== pair.currentFundingIndex ||
      position.positionRoot !== pair.positionRoot || position.proof.publicInputHash !== pair.proof.publicInputHash)) {
      throw new Error("paired close record mismatch");
    }
    if (pair.proof.circuitId !== "position-close-pair") throw new Error("combined paired close proof required");
    this.assertCurrentMarketPrice(pair.marketId, pair.markPrice, "paired position close");
    const proofVerification = this.invokeProofVerifier(pair.proof);
    this.assertCurrentMarketPrice(pair.marketId, pair.markPrice, "paired position close");
    const args = JSON.stringify({
      market_id: marketKey(pair.marketId), mark_price: pair.markPrice.toString(),
      liquidation: pair.liquidation, position_root: bytes32(pair.positionRoot),
      position_commitments: pair.positions.map(position => bytes32(position.positionCommitment)),
      position_nullifiers: pair.positions.map(position => bytes32(position.positionNullifier)),
      close_commitments: pair.positions.map(position => bytes32(position.closeCommitment)),
      new_position_commitments: pair.positions.map(position => bytes32(position.newPositionCommitment)),
      margin_output_commitments: pair.positions.map(position => bytes32(position.marginOutputCommitment)),
    });
    return {relays: [proofVerification,
      this.invokeWithMarketPriceGuard("position-close", "position-close",
        conditional ? "settle_pair_conditional_proven" : "settle_pair_proven", [
          "--args", args, "--proof", proofArg(pair.proof),
        ], pair.marketId, pair.markPrice, "paired position close")]};
  }

  async settleJournaledPositionPair(pair: PairedPositionCloseRecord, conditional: boolean,
    beforeSubmit:(prepared:{txHash:Hex;xdr:string})=>Promise<void>,
    prepared?:{txHash:Hex;xdr:string}):Promise<OnchainRelayResult> {
    if(!this.config.enabled)return empty();
    if(pair.proof.circuitId!=="position-close-pair" || pair.positions.some((position)=>
      position.marketId!==pair.marketId || position.markPrice!==pair.markPrice ||
      position.currentFundingIndex!==pair.currentFundingIndex || position.positionRoot!==pair.positionRoot ||
      position.proof.publicInputHash!==pair.proof.publicInputHash))throw new Error("paired close record mismatch");
    const proofVerification=prepared?undefined:await this.invokeProofVerifierAsync(pair.proof);
    const args=JSON.stringify({market_id:marketKey(pair.marketId),mark_price:pair.markPrice.toString(),
      liquidation:pair.liquidation,position_root:bytes32(pair.positionRoot),
      position_commitments:pair.positions.map((position)=>bytes32(position.positionCommitment)),
      position_nullifiers:pair.positions.map((position)=>bytes32(position.positionNullifier)),
      close_commitments:pair.positions.map((position)=>bytes32(position.closeCommitment)),
      new_position_commitments:pair.positions.map((position)=>bytes32(position.newPositionCommitment)),
      margin_output_commitments:pair.positions.map((position)=>bytes32(position.marginOutputCommitment))});
    const relay=await this.relayer.relayJournaled({kind:"position-close",payload:{
      contractId:contractId(this.deployment(),"position-close"),
      functionName:conditional?"settle_pair_conditional_proven":"settle_pair_proven",
      args:["--args",args,"--proof",proofArg(pair.proof)],send:"yes",
    }},beforeSubmit,prepared);
    return {relays:[...(proofVerification?[proofVerification]:[]),relay]};
  }

  positionPairTransactionStatus(txHash:Hex):Promise<"SUCCESS"|"FAILED"|"NOT_FOUND"> {
    return this.relayer.readTransactionStatus(txHash);
  }

  async positionCloseSettlementTransaction(closeCommitment:Hex):Promise<Hex> {
    if(!this.config.enabled)throw new Error("close receipt lookup requires on-chain relay");
    const closeContract=contractId(this.deployment(),"position-close");
    const result=await this.relayer.readAsync({kind:"position-close",payload:{
      contractId:closeContract,functionName:"closed_ledger",args:["--close_commitment",bytes32(closeCommitment)],send:"no",
    }});
    const raw=(result.stdout ?? result.output).trim().replace(/^"|"$/g,"");
    const ledger=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(ledger)||ledger<=0)throw new Error("close settlement ledger is unavailable");
    const txHash=await this.relayer.findContractEventTransaction(closeContract,ledger,closeCommitment);
    if(await this.relayer.readTransactionStatus(txHash)!=="SUCCESS")throw new Error("close receipt is not confirmed successful");
    return txHash;
  }

  isConditionalTriggered(marketId: string, positionNullifier: Hex, closeCommitment: Hex): boolean {
    if (!this.config.enabled) throw new Error("conditional trigger status requires on-chain relay");
    const result = this.relayer.read({ kind: "contract-invoke", payload: {
      args: ["--market_id", marketKey(marketId), "--position_nullifier", bytes32(positionNullifier),
        "--close_commitment", bytes32(closeCommitment)],
      contractId: contractId(this.deployment(), "conditional-order"), functionName: "is_triggered_for", send: "no",
    } });
    const status = result.output.trim().replace(/^"|"$/g, "");
    if (status !== "true" && status !== "false") throw new Error("invalid conditional trigger status");
    return status === "true";
  }

  async isConditionalTriggeredAsync(marketId: string, positionNullifier: Hex, closeCommitment: Hex): Promise<boolean> {
    if (!this.config.enabled) throw new Error("conditional trigger status requires on-chain relay");
    const result = await this.relayer.readAsync({ kind: "contract-invoke", payload: {
      args: ["--market_id", marketKey(marketId), "--position_nullifier", bytes32(positionNullifier),
        "--close_commitment", bytes32(closeCommitment)],
      contractId: contractId(this.deployment(), "conditional-order"), functionName: "is_triggered_for", send: "no",
    } });
    return parseAuthoritativeBoolean(result.stdout, "conditional trigger status");
  }

  isPositionCloseSettled(closeCommitment: Hex): boolean {
    if (!this.config.enabled) throw new Error("position close status requires on-chain relay");
    const result = this.relayer.read({
      kind: "contract-invoke",
      payload: {
        args: ["--close_commitment", bytes32(closeCommitment)],
        contractId: contractId(this.deployment(), "position-close"),
        functionName: "is_settled",
        send: "no",
      },
    });
    const status = result.output.trim().replace(/^"|"$/g, "");
    if (status !== "true" && status !== "false") {
      throw new Error("invalid position close settlement status");
    }
    return status === "true";
  }

  async isPositionCloseSettledAsync(closeCommitment: Hex): Promise<boolean> {
    if (!this.config.enabled) throw new Error("position close status requires on-chain relay");
    const result = await this.relayer.readAsync({ kind: "contract-invoke", payload: {
      args: ["--close_commitment", bytes32(closeCommitment)],
      contractId: contractId(this.deployment(), "position-close"), functionName: "is_settled", send: "no",
    } });
    return parseAuthoritativeBoolean(result.stdout, "position close settlement status");
  }

  async isPositionSpentAsync(positionNullifier: Hex): Promise<boolean> {
    if (!this.config.enabled) throw new Error("position spend status requires on-chain relay");
    const result = await this.relayer.readAsync({ kind: "contract-invoke", payload: {
      args: ["--position_nullifier", bytes32(positionNullifier)],
      contractId: contractId(this.deployment(), "position-state"), functionName: "is_spent", send: "no",
    } });
    return parseAuthoritativeBoolean(result.stdout, "position spend status");
  }

  positionCloseAppendIndex(closeCommitment:Hex):number {
    if(!this.config.enabled)throw new Error("position close index requires on-chain relay");
    const result=this.relayer.read({kind:"contract-invoke",payload:{
      contractId:contractId(this.deployment(),"position-close"),functionName:"output_position_index",
      args:["--close_commitment",bytes32(closeCommitment)],send:"no",
    }});
    const encoded=(result.stdout ?? result.output).trim();
    const raw=encoded.startsWith('"')?JSON.parse(encoded):encoded;
    if(!/^\d+$/.test(String(raw)))throw new Error("invalid position close append index");
    const index=Number(raw);
    if(!Number.isSafeInteger(index)||index<0||index>0xffffffff)throw new Error("invalid position close append index");
    return index;
  }

  async positionCloseAppendIndexAsync(closeCommitment: Hex): Promise<number> {
    if (!this.config.enabled) throw new Error("position close index requires on-chain relay");
    const result = await this.relayer.readAsync({ kind: "contract-invoke", payload: {
      contractId: contractId(this.deployment(), "position-close"), functionName: "output_position_index",
      args: ["--close_commitment", bytes32(closeCommitment)], send: "no",
    } });
    const encoded = (result.stdout ?? result.output).trim();
    const raw = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
    if (!/^\d+$/.test(String(raw))) throw new Error("invalid position close append index");
    const index = Number(raw);
    if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) throw new Error("invalid position close append index");
    return index;
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
    if (record.proof.circuitId !== "secure-withdraw") {
      throw new Error("secure withdrawal proof required");
    }
    return {
      relays: [
        this.invokeProofVerifier(record.proof),
        this.invoke("withdraw", "shielded-pool", "withdraw_asset_secure", [
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
    signal?: AbortSignal,
  ) {
    return this.invokePayloadAsync(kind, {
      args,
      contractId: verifier
        ? verifierId(this.deployment(), contractName)
        : contractId(this.deployment(), contractName),
      functionName,
    }, signal);
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

  private async assertCurrentMarketPriceAsync(marketId: string, expectedPrice: bigint, operation: string): Promise<void> {
    const currentPrice = await this.marketPriceAsync(marketId);
    if (currentPrice !== expectedPrice) {
      throw new Error(`${operation} mark price mismatch: proof ${expectedPrice}, on-chain ${currentPrice}`);
    }
  }

  private currentMarketPrice(marketId: string): bigint {
    const deployment = this.deployment();
    const result = this.relayer.read({
      kind: "market",
      payload: this.marketPriceReadPayload(marketId),
    });
    return parseOnchainMarketPrice(result.output).price;
  }

  private marketPriceReadPayload(marketId: string) {
    return {
      args: ["--market_id", marketKey(marketId)],
      contractId: contractId(this.deployment(), "market"),
      functionName: "mark_price",
      send: "no" as const,
    };
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
    signal?: AbortSignal,
  ) {
    return this.relayer.relayAsync({ kind, payload, signal });
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
      functionName: "deposit_asset_secure",
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

function marketUpsertInvocation(
  deployment: DeploymentRegistry,
  record: MarketConfig,
  config: OnchainMarketConfig,
): { args: string[]; functionName: string } {
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
  return { args, functionName };
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

function positionCloseArg(record: PositionCloseRecord): string {
  return JSON.stringify({
    market_id: marketKey(record.marketId),
    position_root: bytes32(record.positionRoot),
    position_commitment: bytes32(record.positionCommitment),
    position_nullifier: bytes32(record.positionNullifier),
    close_commitment: bytes32(record.closeCommitment),
    mark_price: record.markPrice.toString(),
    new_position_commitment: bytes32(record.newPositionCommitment),
    margin_output_commitment: bytes32(record.marginOutputCommitment),
    proof: JSON.parse(proofArg(record.proof)),
  });
}

function changeCommitmentArg(commitment: Hex): string {
  return commitment === "0x0" ? "0".repeat(64) : bytes32(commitment);
}

function bytes32(value: Hex | string): string {
  if (value === "0x0") return "0".repeat(64);
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

function parseStrictBoolean(output: string, label: string): boolean {
  const value = output.trim().replace(/^"|"$/g, "");
  if (value !== "true" && value !== "false") throw new Error(`invalid ${label}`);
  return value === "true";
}

function parseAuthoritativeBoolean(stdout: string | undefined, label: string): boolean {
  if (stdout === undefined) throw new Error(`invalid ${label}`);
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`invalid ${label}`); }
  if (typeof value !== "boolean") throw new Error(`invalid ${label}`);
  return value;
}

function strictBatchSettlementStatus(stdout: string | undefined): boolean {
  if (typeof stdout !== "string") throw new Error("invalid batch settlement status");
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new Error("invalid batch settlement status"); }
  if (typeof value !== "boolean") throw new Error("invalid batch settlement status");
  return value;
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
