import {
  protocolUsdcToDisplay,
} from "@/lib/asset-units";
import type { ClientProofProvider, PositionCloseRecord } from "@/lib/client-proof-provider";
import {
  circuitPositionCommitment,
  circuitPositionNullifier,
  digestToFieldHex,
  fieldHashPair,
  randomLabel,
} from "@/lib/private-note";
import { secureMarginCommitment, secureMarginNullifier } from "@pnlx/crypto/secure-margin-commitment";
import {
  privateMarginNoteRuntimeScopeFromHealth,
  savePrivateMarginNote,
  setPrivateMarginNoteRuntimeScope,
} from "@/lib/private-margin-notes";
import { backUpExistingPrivateMarginNotes, backUpPrivateMarginNote, unlockPrivateNoteBackup } from "@/lib/private-note-backup";
import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import type { Hex, MarketDisplay, PositionRow, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

const PRICE_SCALE = 100_000_000n;

interface PositionCloseContextResponse {
  context: {
    payoutAmount: string;
    market: {
      fundingIndex: string;
      marketId: string;
      markPrice: string;
    };
    membershipProof: {
      indices: boolean[];
      leaf: Hex;
      root: Hex;
      siblings: Hex[];
    };
    positionRoot: Hex;
  };
}

interface HealthResponse {
  custody?: {
    collateralAsset?: {
      tokenDigest?: Hex;
      tokenContract?: string;
    };
  };
  persistence?: {
    mongodb?: {
      collection?: string;
      database?: string;
    };
  };
  runtime?: {
    clientStorageScope?: string;
  };
  stellar?: {
    network?: string;
  };
}

interface PositionCloseResponse {
  positionClose: SerializedPositionCloseRecord;
}

export interface ClosePositionInput {
  market: MarketDisplay;
  position: PositionRow;
  proofProvider?: ClientProofProvider;
  session: WalletSession;
}

export interface ClosePositionResult extends PositionCloseRecord {
  settlement: {
    fee: number;
    fundingPayment: number;
    grossPricePnl: number;
    returnedMargin: number;
  };
}

export async function closePosition(input: ClosePositionInput): Promise<ClosePositionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await closePositionAttempt(input);
    } catch (error) {
      if (!isRetryableCloseContextError(error) || attempt > 0) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Position close failed");
}

async function closePositionAttempt(input: ClosePositionInput): Promise<ClosePositionResult> {
  if (input.position.status !== "open") throw new Error("Position is not open");
  if (input.position.marketId !== input.market.marketId) throw new Error("Position close market mismatch");
  if (!input.position.privateState) {
    throw new Error("Private position data is unavailable in this browser");
  }

  const privateState = input.position.privateState;
  const positionCommitment = input.position.commitment;
  if (!positionCommitment) throw new Error("Position commitment is missing");

  const positionSecrets = await reconstructPositionSecrets({
    entryPrice: BigInt(privateState.entryPrice),
    fundingIndex: BigInt(privateState.fundingIndex),
    margin: BigInt(privateState.margin),
    marketId: input.market.marketId,
    ownerDigest: privateState.ownerDigest,
    positionSeed: privateState.positionSeed,
    fillIndex: privateState.fillIndex,
    positionCommitment,
    positionNullifier: privateState.positionNullifier,
    side: privateState.side,
    size: BigInt(privateState.size),
  });

  const closeCommitment = await digestToFieldHex(
    `manual-position-close:${positionCommitment}:${Date.now()}:${randomLabel("close")}`,
  );
  const newPositionRhoDigest = await digestToFieldHex(
    `rho:${positionCommitment}:closed:${randomLabel("position-rho")}`,
  );
  const newPositionBlinding = await digestToFieldHex(
    `blinding:${positionCommitment}:closed:${randomLabel("position-blind")}`,
  );
  const newPositionCommitment = circuitPositionCommitment({
    blinding: newPositionBlinding,
    entryPrice: BigInt(privateState.entryPrice),
    fundingIndex: BigInt(privateState.fundingIndex),
    margin: 0n,
    marketDigest: positionSecrets.marketDigest,
    ownerDigest: positionSecrets.ownerDigest,
    rhoDigest: newPositionRhoDigest,
    side: privateState.side,
    size: 0n,
    spendSecretDigest: positionSecrets.spendSecretDigest,
  });

  const context = (await pnlxGet<PositionCloseContextResponse>(
    `/position-closes/context?ownerCommitment=${encodeURIComponent(input.session.ownerCommitment)}` +
      `&positionCommitment=${encodeURIComponent(positionCommitment)}`,
    input.session.token,
  )).context;
  if (context.market.marketId !== input.market.marketId) {
    throw new Error("Position close context market mismatch");
  }

  const markPrice = BigInt(context.market.markPrice);
  const currentFundingIndex = BigInt(context.market.fundingIndex);
  const fundingPayment = expectedFundingPayment({
    currentFundingIndex,
    fundingIndex: BigInt(privateState.fundingIndex),
    side: privateState.side,
    size: BigInt(privateState.size),
  });
  const fee = 0n;
  const closeSettlement = settleClose({
    closeSize: BigInt(privateState.size),
    entryPrice: BigInt(privateState.entryPrice),
    fee,
    fundingPayment,
    margin: BigInt(privateState.margin),
    markPrice,
    side: privateState.side,
  });
  if (!/^[0-9]+$/.test(context.payoutAmount)) throw new Error("Paired close payout context is unavailable");
  const payoutAmount = BigInt(context.payoutAmount);
  if (payoutAmount > closeSettlement.newMargin) throw new Error("Paired close payout exceeds position equity");
  closeSettlement.newMargin = payoutAmount;

  const marginOutputAssetDigest = await collateralAssetDigest(input.session.token);
  const marginOutputRhoDigest = await digestToFieldHex(
    `rho:${positionCommitment}:close-margin:${randomLabel("margin-rho")}`,
  );
  const marginOutputBlinding = await digestToFieldHex(
    `blinding:${positionCommitment}:close-margin:${randomLabel("margin-blind")}`,
  );
  const marginOutputSpendSecretDigest = await digestToFieldHex(
    `spend:${positionCommitment}:close-margin:${randomLabel("margin-spend")}`,
  );
  const marginOutputCommitment = secureMarginCommitment({
    amount: closeSettlement.newMargin,
    assetDigest: marginOutputAssetDigest,
    blinding: marginOutputBlinding,
    ownerDigest: positionSecrets.ownerDigest,
    rhoDigest: marginOutputRhoDigest,
    spendSecretDigest: marginOutputSpendSecretDigest,
  });

  if (closeSettlement.newMargin > 0n) {
    await unlockPrivateNoteBackup(input.session);
    await backUpExistingPrivateMarginNotes(input.session);
    const pending = savePrivateMarginNote({
      amount: closeSettlement.newMargin.toString(), assetDigest: marginOutputAssetDigest,
      blinding: marginOutputBlinding, commitment: marginOutputCommitment,
      noteNullifier: secureMarginNullifier({ rhoDigest: marginOutputRhoDigest,
        spendSecretDigest: marginOutputSpendSecretDigest }),
      noteFormat: "secure",
      ownerCommitment: input.session.ownerCommitment, ownerDigest: positionSecrets.ownerDigest,
      rhoDigest: marginOutputRhoDigest, spendSecretDigest: marginOutputSpendSecretDigest,
      walletAddress: input.session.address, status: "pending",
    });
    await backUpPrivateMarginNote(pending, input.session);
  }

  const witness = {
      blinding: positionSecrets.blinding,
      closeCommitment,
      closeSize: BigInt(privateState.size),
      currentFundingIndex,
      entryPrice: BigInt(privateState.entryPrice),
      fee,
      fundingIndex: BigInt(privateState.fundingIndex),
      fundingPayment,
      margin: BigInt(privateState.margin),
      marginOutputAmount: closeSettlement.newMargin,
      marginOutputAssetDigest,
      marginOutputBlinding,
      marginOutputCommitment,
      marginOutputRhoDigest,
      marginOutputSpendSecretDigest,
      marketDigest: positionSecrets.marketDigest,
      marketId: input.market.marketId,
      markPrice,
      newMargin: closeSettlement.newMargin,
      newPositionBlinding,
      newPositionCommitment,
      newPositionRhoDigest,
      ownerDigest: positionSecrets.ownerDigest,
      pathIndices: context.membershipProof.indices,
      pathSiblings: context.membershipProof.siblings,
      positionCommitment,
      positionNullifier: privateState.positionNullifier,
      positionRoot: context.positionRoot,
      remainingMargin: 0n,
      rhoDigest: positionSecrets.rhoDigest,
      side: privateState.side,
      size: BigInt(privateState.size),
      spendSecretDigest: positionSecrets.spendSecretDigest,
    };

  const response = await pnlxPost<PositionCloseResponse>(
    "/position-closes/manual",
    witness,
    input.session.token,
  );
  const positionClose = normalizePositionCloseRecord(response.positionClose);
  if (positionClose.positionCommitment.toLowerCase() !== positionCommitment.toLowerCase() ||
      positionClose.positionNullifier.toLowerCase() !== privateState.positionNullifier.toLowerCase() ||
      positionClose.marginOutputCommitment.toLowerCase() !== marginOutputCommitment.toLowerCase()) {
    throw new Error("Position close confirmation does not match the submitted output");
  }
  if (closeSettlement.newMargin > 0n) {
    savePrivateMarginNote({
      amount: closeSettlement.newMargin.toString(),
      assetDigest: marginOutputAssetDigest,
      blinding: marginOutputBlinding,
      commitment: marginOutputCommitment,
      noteNullifier: secureMarginNullifier({ rhoDigest: marginOutputRhoDigest,
        spendSecretDigest: marginOutputSpendSecretDigest }),
      noteFormat: "secure",
      ownerCommitment: input.session.ownerCommitment,
      ownerDigest: positionSecrets.ownerDigest,
      rhoDigest: marginOutputRhoDigest,
      spendSecretDigest: marginOutputSpendSecretDigest,
      walletAddress: input.session.address,
    });
  }
  return {
    ...positionClose,
    settlement: {
      fee: protocolUsdcToDisplay(fee),
      fundingPayment: protocolUsdcToDisplay(fundingPayment),
      grossPricePnl: protocolUsdcToDisplay(closeSettlement.realizedPnl),
      returnedMargin: protocolUsdcToDisplay(closeSettlement.newMargin),
    },
  };
}

function normalizePositionCloseRecord(
  record: SerializedPositionCloseRecord,
): PositionCloseRecord {
  return {
    ...record,
    markPrice: BigInt(record.markPrice),
    currentFundingIndex: BigInt(record.currentFundingIndex),
  };
}

type SerializedPositionCloseRecord = Omit<PositionCloseRecord, "markPrice" | "currentFundingIndex"> & {
  markPrice: string;
  currentFundingIndex: string;
};

function isRetryableCloseContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "position close mark price mismatch",
    "mark price mismatch",
    "position root is not current",
  ].some((entry) => message.includes(entry));
}

async function collateralAssetDigest(token?: string): Promise<Hex> {
  const health = await pnlxGet<HealthResponse>("/health", token);
  setPrivateMarginNoteRuntimeScope(privateMarginNoteRuntimeScopeFromHealth(health));
  const assetDigest = health.custody?.collateralAsset?.tokenDigest;
  if (!assetDigest) throw new Error("Collateral token digest is not configured");
  return assetDigest;
}

export async function reconstructPositionSecrets(input: {
  entryPrice: bigint;
  fundingIndex: bigint;
  margin: bigint;
  marketId: string;
  ownerDigest?: Hex;
  positionSeed?: Hex;
  fillIndex?: number;
  positionCommitment: Hex;
  positionNullifier: Hex;
  side: Side;
  size: bigint;
}) {
  if (!input.ownerDigest || !input.positionSeed || BigInt(input.positionSeed) === 0n ||
      !Number.isSafeInteger(input.fillIndex) || input.fillIndex! < 0) {
    throw new Error("Private position spending data is unavailable; recover the encrypted position opening");
  }
  const marketDigest = await digestToFieldHex(`pnlx:market-id:${input.marketId}`);
  const ownerDigest = input.ownerDigest;
  const scoped = fieldHashPair(input.positionSeed, BigInt(input.fillIndex!));
  const rhoDigest = fieldHashPair(0x504e4c5852484fn, scoped);
  const blinding = fieldHashPair(0x504e4c58424c494e44n, scoped);
  const spendSecretDigest = fieldHashPair(0x504e4c585350454e44n, scoped);
  const commitment = circuitPositionCommitment({
      blinding,
      entryPrice: input.entryPrice,
      fundingIndex: input.fundingIndex,
      margin: input.margin,
      marketDigest,
      ownerDigest,
      rhoDigest,
      side: input.side,
      size: input.size,
      spendSecretDigest,
    });
  const nullifier = circuitPositionNullifier({ rhoDigest, spendSecretDigest });
  if (commitment.toLowerCase() === input.positionCommitment.toLowerCase() &&
      nullifier.toLowerCase() === input.positionNullifier.toLowerCase()) {
      return { blinding, marketDigest, ownerDigest, rhoDigest, spendSecretDigest };
    }
  throw new Error("Private position witness could not be reconstructed");
}

function expectedFundingPayment(input: {
  currentFundingIndex: bigint;
  fundingIndex: bigint;
  side: Side;
  size: bigint;
}): bigint {
  const payment = (input.size * (input.currentFundingIndex - input.fundingIndex)) / PRICE_SCALE;
  return input.side === "long" ? payment : -payment;
}

function settleClose(input: {
  closeSize: bigint;
  entryPrice: bigint;
  fee: bigint;
  fundingPayment: bigint;
  margin: bigint;
  markPrice: bigint;
  side: Side;
}) {
  const delta = input.side === "long" ? input.markPrice - input.entryPrice : input.entryPrice - input.markPrice;
  const realizedPnl = (input.closeSize * delta) / PRICE_SCALE;
  const newMargin = input.margin + realizedPnl - input.fundingPayment - input.fee;
  if (newMargin < 0n) throw new Error("Position is insolvent and must be liquidated");
  return { newMargin, realizedPnl };
}
