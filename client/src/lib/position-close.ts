import {
  defaultClientProofProvider,
  registerProofBundle,
  type ClientProofProvider,
  type PositionCloseRecord,
} from "@/lib/client-proof-provider";
import {
  circuitPositionCommitment,
  circuitPositionNullifier,
  createCircuitMarginCommitment,
  digestToFieldHex,
  randomLabel,
} from "@/lib/private-note";
import { pnlxGet, pnlxPost } from "@/lib/pnlx-api";
import type { Hex, MarketDisplay, PositionRow, Side } from "@/types/trading";
import type { WalletSession } from "@/lib/wallet-auth";

const PRICE_SCALE = 100_000_000n;
const ZERO_HEX = `0x${"0".repeat(64)}` as Hex;
const MAX_FILL_INDEX_SCAN = 512;

interface PositionCloseContextResponse {
  context: {
    membershipProof: {
      indices: boolean[];
      leaf: Hex;
      root: Hex;
      siblings: Hex[];
    };
    newPositionRoot: Hex;
    positionRoot: Hex;
  };
}

interface HealthResponse {
  custody?: {
    collateralAsset?: {
      tokenDigest?: Hex;
    };
  };
}

interface PositionCloseResponse {
  positionClose: PositionCloseRecord;
}

export interface ClosePositionInput {
  market: MarketDisplay;
  position: PositionRow;
  proofProvider?: ClientProofProvider;
  session: WalletSession;
}

export async function closePosition(input: ClosePositionInput): Promise<PositionCloseRecord> {
  if (input.position.status !== "open") throw new Error("Position is not open");
  if (!input.position.privateState) {
    throw new Error("Private position data is unavailable in this browser");
  }

  const proofProvider = input.proofProvider ?? defaultClientProofProvider();
  if (!proofProvider) throw new Error("Client proof provider is not configured");

  const privateState = input.position.privateState;
  const positionCommitment = input.position.commitment;
  if (!positionCommitment) throw new Error("Position commitment is missing");

  const positionSecrets = await reconstructPositionSecrets({
    entryPrice: BigInt(privateState.entryPrice),
    fundingIndex: BigInt(privateState.fundingIndex),
    margin: BigInt(privateState.margin),
    marketId: input.market.marketId,
    ownerCommitment: input.session.ownerCommitment,
    positionCommitment,
    positionNullifier: privateState.positionNullifier,
    side: privateState.side,
    size: BigInt(privateState.size),
    sourceIntentCommitment: privateState.sourceIntentCommitment,
  });

  const closeCommitment = await digestToFieldHex(
    `manual-position-close:${positionCommitment}:${Date.now()}:${randomLabel("close")}`,
  );
  const markPrice = BigInt(input.market.oraclePrice);
  const fundingPayment = expectedFundingPayment({
    currentFundingIndex: BigInt(input.market.fundingIndex),
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
      `&positionCommitment=${encodeURIComponent(positionCommitment)}` +
      `&newPositionCommitment=${encodeURIComponent(newPositionCommitment)}`,
    input.session.token,
  )).context;

  const marginOutputAssetDigest = await collateralAssetDigest(input.session.token);
  const marginOutputRhoDigest = await digestToFieldHex(
    `rho:${positionCommitment}:close-margin:${randomLabel("margin-rho")}`,
  );
  const marginOutputBlinding = await digestToFieldHex(
    `blinding:${positionCommitment}:close-margin:${randomLabel("margin-blind")}`,
  );
  const marginOutputCommitment = createCircuitMarginCommitment({
    amount: closeSettlement.newMargin,
    assetDigest: marginOutputAssetDigest,
    blinding: marginOutputBlinding,
    ownerDigest: positionSecrets.ownerDigest,
    rhoDigest: marginOutputRhoDigest,
    spendSecretDigest: ZERO_HEX,
  });

  const proven = await registerProofBundle(
    await proofProvider.positionClose({
      blinding: positionSecrets.blinding,
      closeCommitment,
      closeSize: BigInt(privateState.size),
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
      marketDigest: positionSecrets.marketDigest,
      marketId: input.market.marketId,
      markPrice,
      newMargin: closeSettlement.newMargin,
      newPositionBlinding,
      newPositionCommitment,
      newPositionRhoDigest,
      newPositionRoot: context.newPositionRoot,
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
    }),
    input.session.token,
  );

  const response = await pnlxPost<PositionCloseResponse>(
    "/position-closes/manual-proven",
    proven,
    input.session.token,
  );
  return response.positionClose;
}

async function collateralAssetDigest(token?: string): Promise<Hex> {
  const health = await pnlxGet<HealthResponse>("/health", token);
  return health.custody?.collateralAsset?.tokenDigest ?? digestToFieldHex("asset:usdc");
}

async function reconstructPositionSecrets(input: {
  entryPrice: bigint;
  fundingIndex: bigint;
  margin: bigint;
  marketId: string;
  ownerCommitment: Hex;
  positionCommitment: Hex;
  positionNullifier: Hex;
  side: Side;
  size: bigint;
  sourceIntentCommitment: Hex;
}) {
  const marketDigest = await digestToFieldHex(`market:${input.marketId}`);
  const ownerDigest = await digestToFieldHex(`owner:${input.ownerCommitment}`);

  for (let fillIndex = 0; fillIndex < MAX_FILL_INDEX_SCAN; fillIndex += 1) {
    const rho = `${input.sourceIntentCommitment}:position:${fillIndex}`;
    const rhoDigest = await digestToFieldHex(`rho:${rho}`);
    const blinding = await digestToFieldHex(`blinding:${input.sourceIntentCommitment}:blinding:${fillIndex}`);
    const spendSecretDigest = await digestToFieldHex(`spend:${input.ownerCommitment}:${rho}`);
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
    if (commitment === input.positionCommitment && nullifier === input.positionNullifier) {
      return { blinding, marketDigest, ownerDigest, rhoDigest, spendSecretDigest };
    }
  }

  throw new Error("Private position witness could not be reconstructed");
}

function expectedFundingPayment(input: {
  currentFundingIndex: bigint;
  fundingIndex: bigint;
  side: Side;
  size: bigint;
}): bigint {
  const payment = input.size * (input.currentFundingIndex - input.fundingIndex);
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
