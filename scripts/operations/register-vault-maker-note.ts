import { loadEnv } from "@/config/env";
import { LiquidityVaultService } from "@/features/liquidity-vault/liquidity-vault.service";
import { readMakerNotes } from "@/shared/maker-note-store";
import {
  allocationId,
  normalizedHash,
  readVaultMakerAllocations,
  registerVaultMakerNote,
} from "@/shared/vault-maker-backing";
import { loadDeploymentRegistry } from "@/workers/onchain/deployment";
import { createRelayer } from "@/workers/relayer/relayer.worker";

if (import.meta.main) {
  await register(process.argv.slice(2));
}

export async function register(argv: string[]): Promise<void> {
  const commitment = requiredArg(argv, "--commitment");
  const allocationTxHash = normalizedHash(requiredArg(argv, "--allocation-tx"));

  const env = loadEnv();
  if (env.stellarNetwork !== "testnet" || env.stellarRelayerMode !== "stellar-cli" ||
    !env.stellarOnchainRelay || !env.makerWalletAddress || !env.collateralTokenContract) {
    throw new Error("Testnet vault maker, Stellar relay, and collateral token are required");
  }
  const deployment = loadDeploymentRegistry(env.stellarDeploymentFile);
  const vaultId = deployment?.contracts["liquidity-vault"];
  const poolId = deployment?.contracts["shielded-pool"];
  if (!vaultId || !poolId) throw new Error("vault and shielded pool deployments are required");

  const maker = env.makerWalletAddress.trim().toUpperCase();
  const allocation = (await readVaultMakerAllocations())
    .find((record) => record.id === allocationId(vaultId, allocationTxHash));
  if (!allocation || allocation.status !== "outstanding" ||
    allocation.asset !== env.collateralTokenContract || allocation.maker !== maker) {
    throw new Error("no outstanding allocation created by the vault allocation command");
  }
  const note = (await readMakerNotes()).find((candidate) => candidate.commitment === commitment);
  if (!note || note.status !== "available" || note.walletAddress !== maker ||
    note.token !== env.collateralTokenContract || !note.depositTxHash || !note.noteNullifier ||
    !note.assetDigest || !note.amount) {
    throw new Error("available maker note with a finalized collateral deposit is required");
  }
  const depositTxHash = normalizedHash(String(note.depositTxHash));
  if (depositTxHash === allocationTxHash) throw new Error("allocation and note deposit must be different transactions");
  const [allocationLedger, depositLedger] = await Promise.all([
    assertSuccessfulTransaction(env.stellarRpcUrl, allocationTxHash),
    assertSuccessfulTransaction(env.stellarRpcUrl, depositTxHash),
  ]);
  if (allocationLedger !== allocation.allocationLedger || depositLedger <= allocationLedger) {
    throw new Error("maker note deposit must follow the recorded vault allocation");
  }

  const relayer = createRelayer({
    config: {
      commandTimeoutMs: env.stellarCommandTimeoutMs,
      mode: "stellar-cli",
      network: env.stellarNetwork,
      networkPassphrase: env.stellarNetworkPassphrase,
      rpcUrl: env.stellarRpcUrl,
      source: env.stellarSource,
    },
  });
  const vault = await new LiquidityVaultService(relayer, deployment).status();
  if (vault.contractId !== vaultId || vault.asset !== env.collateralTokenContract ||
    vault.maker !== maker || !vault.paused ||
    BigInt(vault.deployedPrincipal) < BigInt(allocation.amount)) {
    throw new Error("vault allocation is not outstanding for this maker and asset");
  }

  const [hasCommitment, spent, assetDigest] = await Promise.all([
    contractRead(relayer, poolId, "has_commitment", ["--commitment", stripHex(commitment)]),
    contractRead(relayer, poolId, "is_spent", ["--nullifier", stripHex(String(note.noteNullifier))]),
    contractRead(relayer, poolId, "token_digest", ["--token", env.collateralTokenContract]),
  ]);
  if (hasCommitment !== true || spent !== false ||
    String(assetDigest).toLowerCase() !== String(note.assetDigest).toLowerCase()) {
    throw new Error("maker note commitment, nullifier, or asset does not match the shielded pool");
  }

  const registered = await registerVaultMakerNote({
    allocationTxHash,
    asset: env.collateralTokenContract,
    commitment,
    depositTxHash,
    maker,
    noteAmount: String(note.amount),
    vault: vaultId,
  });
  process.stdout.write(`${JSON.stringify({ allocationId: registered.id, commitment, status: "registered" })}\n`);
}

export async function assertSuccessfulTransaction(
  rpcUrl: string,
  txHash: string,
  fetchTransaction: typeof fetch = fetch,
): Promise<number> {
  const hash = normalizedHash(txHash);
  const response = await fetchTransaction(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } }),
  });
  if (!response.ok) throw new Error(`Stellar RPC rejected transaction lookup (${response.status})`);
  const body = await response.json() as {
    error?: unknown;
    result?: { ledger?: number; status?: string; txHash?: string };
  };
  if (body.error || body.result?.status !== "SUCCESS" ||
    normalizedHash(String(body.result?.txHash ?? "")) !== hash ||
    !Number.isSafeInteger(body.result?.ledger) || (body.result?.ledger ?? 0) <= 0) {
    throw new Error(`Stellar transaction ${hash} is not confirmed successful`);
  }
  return body.result.ledger!;
}

async function contractRead(
  relayer: ReturnType<typeof createRelayer>,
  contractId: string,
  functionName: string,
  args: string[],
): Promise<unknown> {
  const result = await relayer.readAsync({
    kind: "contract-invoke",
    payload: { args, contractId, functionName, send: "no" },
  });
  try {
    return JSON.parse(result.output.trim());
  } catch {
    return result.output.trim();
  }
}

function stripHex(value: string): string {
  const raw = value.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("invalid note digest");
  return raw;
}

function requiredArg(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
