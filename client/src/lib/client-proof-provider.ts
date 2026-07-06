import {
  registerClientProofArtifact,
  type ClientProofArtifactRegistration,
} from "@/lib/proof-artifacts";
import type { Hex, ServerProofMeta, Side } from "@/types/trading";

export interface DepositNoteProofRecord {
  amount: string;
  commitment: Hex;
  tokenDigest: Hex;
  proof: ServerProofMeta;
}

export interface IntentValidityRecord {
  batchDigest: Hex;
  currentBatch: string;
  expiryBatch: string;
  intentCommitment: Hex;
  marketDigest: Hex;
  marginRoot: Hex;
  noteChangeCommitment: Hex;
  noteCommitment: Hex;
  noteNullifier: Hex;
  ownerCommitmentField: Hex;
  proof: ServerProofMeta;
}

export interface PositionCloseRecord {
  closeCommitment: Hex;
  marginOutputCommitment: Hex;
  marketId: string;
  markPrice: bigint;
  newPositionCommitment: Hex;
  newPositionRoot: Hex;
  positionCommitment: Hex;
  positionNullifier: Hex;
  positionRoot: Hex;
  proof: ServerProofMeta;
  txHash?: Hex;
}

export interface WithdrawalRecord {
  changeCommitment: Hex;
  nullifier: Hex;
  proof: ServerProofMeta;
  recipient: Hex;
  root: Hex;
  tokenDigest: Hex;
  withdrawAmount: string;
}

export interface ProofBundle<T> {
  artifact: ClientProofArtifactRegistration;
  record: T;
}

export interface ClientProofProvider {
  depositNote(input: {
    amount: bigint;
    blinding: Hex;
    commitment: Hex;
    ownerDigest: Hex;
    rhoDigest: Hex;
    tokenDigest: Hex;
  }): Promise<ProofBundle<DepositNoteProofRecord>>;

  intentValidity(input: {
    assetDigest: Hex;
    batchId: string;
    blinding: Hex;
    changeBlinding: Hex;
    changeRhoDigest: Hex;
    currentBatch: bigint;
    expiryBatch: bigint;
    limitPrice: bigint;
    margin: bigint;
    marginRoot: Hex;
    marketId: string;
    nonce: string;
    noteAmount: bigint;
    noteChangeCommitment: Hex;
    noteCommitment: Hex;
    noteNullifier: Hex;
    owner: string;
    ownerDigest: Hex;
    pathIndices: boolean[];
    pathSiblings: Hex[];
    rhoDigest: Hex;
    salt: string;
    side: Side;
    size: bigint;
    spendSecretDigest: Hex;
  }): Promise<ProofBundle<IntentValidityRecord>>;

  positionClose(input: {
    blinding: Hex;
    closeCommitment: Hex;
    closeSize: bigint;
    entryPrice: bigint;
    fee: bigint;
    fundingIndex: bigint;
    fundingPayment: bigint;
    margin: bigint;
    marginOutputAmount: bigint;
    marginOutputAssetDigest: Hex;
    marginOutputBlinding: Hex;
    marginOutputCommitment: Hex;
    marginOutputRhoDigest: Hex;
    marketDigest: Hex;
    marketId: string;
    markPrice: bigint;
    newMargin: bigint;
    newPositionBlinding: Hex;
    newPositionCommitment: Hex;
    newPositionRhoDigest: Hex;
    newPositionRoot: Hex;
    ownerDigest: Hex;
    pathIndices: boolean[];
    pathSiblings: Hex[];
    positionCommitment: Hex;
    positionNullifier: Hex;
    positionRoot: Hex;
    remainingMargin: bigint;
    rhoDigest: Hex;
    side: Side;
    size: bigint;
    spendSecretDigest: Hex;
  }): Promise<ProofBundle<PositionCloseRecord>>;

  withdraw(input: {
    assetDigest: Hex;
    blinding: Hex;
    changeBlinding: Hex;
    changeRhoDigest: Hex;
    noteAmount: bigint;
    noteCommitment: Hex;
    nullifier: Hex;
    ownerDigest: Hex;
    pathIndices: boolean[];
    pathSiblings: Hex[];
    recipient: Hex;
    rhoDigest: Hex;
    root: Hex;
    spendSecretDigest: Hex;
    tokenDigest: Hex;
    withdrawAmount: bigint;
  }): Promise<ProofBundle<WithdrawalRecord>>;
}

export function defaultClientProofProvider(): ClientProofProvider | undefined {
  const baseUrl = process.env.NEXT_PUBLIC_PNLX_PROVER_URL?.trim();
  return baseUrl ? new HttpClientProofProvider(baseUrl) : undefined;
}

export async function registerProofBundle<T>(
  bundle: ProofBundle<T>,
  token?: string,
): Promise<T> {
  await registerClientProofArtifact(bundle.artifact, token);
  return bundle.record;
}

class HttpClientProofProvider implements ClientProofProvider {
  constructor(private readonly baseUrl: string) {}

  depositNote(input: Parameters<ClientProofProvider["depositNote"]>[0]) {
    return this.post<DepositNoteProofRecord>("/deposit-note", stringifyBigInts(input));
  }

  intentValidity(input: Parameters<ClientProofProvider["intentValidity"]>[0]) {
    return this.post<IntentValidityRecord>("/intent-validity", stringifyBigInts(input));
  }

  positionClose(input: Parameters<ClientProofProvider["positionClose"]>[0]) {
    return this.post<PositionCloseRecord>("/position-close", stringifyBigInts(input));
  }

  withdraw(input: Parameters<ClientProofProvider["withdraw"]>[0]) {
    return this.post<WithdrawalRecord>("/withdraw", stringifyBigInts(input));
  }

  private async post<T>(path: string, data: Record<string, unknown>): Promise<ProofBundle<T>> {
    const response = await fetch(providerUrl(this.baseUrl, path), {
      body: JSON.stringify(data),
      cache: "no-store",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as unknown : undefined;
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Client proof provider failed with ${response.status}`;
      throw new Error(message);
    }
    return body as ProofBundle<T>;
  }
}

function providerUrl(baseUrl: string, path: string): URL {
  const cleanPath = path.replace(/^\/+/, "");
  const base = normalizedBase(baseUrl);
  if (/^[a-z][a-z\d+.-]*:/i.test(base)) return new URL(cleanPath, base);
  if (typeof window === "undefined") {
    throw new Error("Relative proof provider URL requires a browser origin");
  }
  return new URL(cleanPath, new URL(base, window.location.origin));
}

function normalizedBase(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stringifyBigInts(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ]),
  );
}
