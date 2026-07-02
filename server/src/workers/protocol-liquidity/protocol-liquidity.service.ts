import { createECDH } from "node:crypto";
import {
  circuitMarginCommitment,
  circuitNullifier,
  digestToFieldHex,
  ownerCommitment,
} from "@pnlx/crypto";
import { initialMargin, notional, PRICE_SCALE } from "@pnlx/market-math";
import type { MarketConfig, Side, TradeIntent } from "@pnlx/protocol-types";
import type { ExecutorService } from "@/workers/executor/executor.service";
import type { ProverService } from "@/workers/prover/prover.service";
import type { ProtocolLiquidityConfig, ProtocolLiquiditySeedResult } from "@/workers/protocol-liquidity/protocol-liquidity.model";

const LP_BATCH_PREFIX = "lp-";
const DEFAULT_CURRENT_BATCH = 1n;
const DEFAULT_EXPIRY_BATCH = 2n;

export class ProtocolLiquidityService {
  private readonly publicKey: string;

  constructor(
    private readonly executor: ExecutorService,
    private readonly prover: ProverService,
    private readonly config: ProtocolLiquidityConfig,
  ) {
    this.publicKey = config.publicKey || generateP256PublicKey();
  }

  seedMarket(marketId: string, batchId: string): ProtocolLiquiditySeedResult {
    if (!this.config.enabled) return { created: 0, marketId };
    const market = this.executor.store.markets.get(marketId);
    if (!market) throw new Error("unknown market");

    this.ensureAccountKey();
    const size = this.quoteSize(market);
    if (size <= 0n) return { created: 0, marketId };

    let created = 0;
    if (!this.hasOpenQuote(marketId, "long")) {
      this.submitQuote({
        batchId: `${LP_BATCH_PREFIX}${batchId}-long`,
        limitPrice: this.quotePrice(market.oraclePrice, "long"),
        market,
        side: "long",
        size,
      });
      created += 1;
    }
    if (!this.hasOpenQuote(marketId, "short")) {
      this.submitQuote({
        batchId: `${LP_BATCH_PREFIX}${batchId}-short`,
        limitPrice: this.quotePrice(market.oraclePrice, "short"),
        market,
        side: "short",
        size,
      });
      created += 1;
    }

    return { created, marketId };
  }

  private hasOpenQuote(marketId: string, side: Side): boolean {
    for (const order of this.executor.store.orderLifecycle.values()) {
      if (
        order.marketId === marketId &&
        isProtocolLiquidityBatch(order.batchId) &&
        order.batchId.endsWith(`-${side}`) &&
        (order.status === "open" || order.status === "partially-filled")
      ) {
        return true;
      }
    }
    return false;
  }

  private submitQuote(input: {
    batchId: string;
    limitPrice: bigint;
    market: MarketConfig;
    side: Side;
    size: bigint;
  }): void {
    const margin = this.quoteMargin(input.size, input.limitPrice, input.market);
    const note = this.createMarginNote({
      amount: margin,
      label: `${input.batchId}-${input.side}`,
    });
    this.executor.deposit(note.commitment);
    const proof = this.executor.store.marginMembershipProof(note.commitment);
    const intent: TradeIntent = {
      batchId: input.batchId,
      limitPrice: input.limitPrice,
      margin,
      marketId: input.market.marketId,
      nonce: `${input.batchId}:nonce`,
      noteNullifier: note.noteNullifier,
      owner: this.config.owner,
      salt: `${input.batchId}:salt`,
      side: input.side,
      size: input.size,
    };
    const validity = this.prover.proveIntentValidity({
      assetDigest: this.config.tokenDigest,
      blinding: note.blinding,
      currentBatch: DEFAULT_CURRENT_BATCH,
      expiryBatch: DEFAULT_EXPIRY_BATCH,
      intent,
      marginRoot: proof.root,
      noteAmount: note.amount,
      noteCommitment: note.commitment,
      ownerDigest: note.ownerDigest,
      pathIndices: proof.indices,
      pathSiblings: proof.siblings,
      rhoDigest: note.rhoDigest,
      spendSecretDigest: note.spendSecretDigest,
    });
    this.executor.store.recordProof(validity.proof);
    this.executor.submitIntent({ intent, validity });
  }

  private quoteSize(market: MarketConfig): bigint {
    if (this.config.maxNotional <= 0n || market.oraclePrice <= 0n) return 0n;
    const size = (this.config.maxNotional * PRICE_SCALE) / market.oraclePrice;
    return size > 0n ? size : 1n;
  }

  private quoteMargin(size: bigint, price: bigint, market: MarketConfig): bigint {
    const requiredInitial = initialMargin(size, price, market.initialMarginRate);
    const requiredMaxLeverage = ceilDiv(notional(size, price), market.maxLeverage);
    return max(requiredInitial, requiredMaxLeverage) + 1n;
  }

  private quotePrice(oraclePrice: bigint, side: Side): bigint {
    const spreadBps = this.config.quoteSpreadBps < 10_000n
      ? this.config.quoteSpreadBps
      : 9_999n;
    const bps = side === "long"
      ? 10_000n - spreadBps
      : 10_000n + spreadBps;
    const price = (oraclePrice * bps) / 10_000n;
    return price > 0n ? price : oraclePrice;
  }

  private createMarginNote(input: { amount: bigint; label: string }) {
    const ownerDigest = digestToFieldHex(`owner:${this.config.owner}`);
    const rhoDigest = digestToFieldHex(`rho:${input.label}:rho`);
    const blinding = digestToFieldHex(`blinding:${input.label}:blind`);
    const spendSecretDigest = digestToFieldHex(`spend:${input.label}:spend`);
    const commitment = circuitMarginCommitment({
      amount: input.amount,
      assetDigest: this.config.tokenDigest,
      blinding,
      ownerDigest,
      rhoDigest,
      spendSecretDigest,
    });
    const noteNullifier = circuitNullifier({ rhoDigest, spendSecretDigest });

    return {
      amount: input.amount,
      blinding,
      commitment,
      noteNullifier,
      ownerDigest,
      rhoDigest,
      spendSecretDigest,
    };
  }

  private ensureAccountKey(): void {
    const commitment = ownerCommitment(this.config.owner);
    this.executor.store.upsertAccountEncryptionKey({
      algorithm: "ecdh-p256-aes-gcm",
      createdAt: this.executor.store.accountEncryptionKey(commitment)?.createdAt ?? Date.now(),
      ownerCommitment: commitment,
      publicKey: this.publicKey,
      updatedAt: Date.now(),
    });
  }
}

export function isProtocolLiquidityBatch(batchId: string): boolean {
  return batchId.startsWith(LP_BATCH_PREFIX);
}

function generateP256PublicKey(): string {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
