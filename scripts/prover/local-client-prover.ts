import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProverService } from "@/workers/prover/prover.service";
import type { ProofMeta } from "@pnlx/protocol-types";
import type { ProofArtifact } from "@pnlx/proof-system";

const DEFAULT_PORT = 4101;
const BATCH_MATCH_PROGRAM_PATH = "/risc0/batch-match.bin";

export function createLocalClientProverHandler(root = process.cwd()) {
  const prover = new ProverService(root);
  return async function handleLocalClientProver(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "pnlx-local-client-prover" });
      }
      if (request.method === "GET" && url.pathname === BATCH_MATCH_PROGRAM_PATH) {
        const path = process.env.RISC0_BATCH_MATCH_PROGRAM_PATH || join(
          root,
          "risc0/batch-match/target/riscv-guest/pnlx-risc0-methods/guest/" +
            "riscv32im-risc0-zkvm-elf/release/batch_match.bin",
        );
        if (!existsSync(path)) {
          return cors(Response.json({ error: "RISC0 batch-match program is not built" }, { status: 404 }));
        }
        return cors(new Response(readFileSync(path), {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/octet-stream",
          },
        }));
      }
      if (request.method === "POST" && url.pathname === "/deposit-note") {
        const input = await request.json() as Record<string, unknown>;
        const record = prover.proveDepositNote({
          amount: BigInt(String(input.amount)),
          blinding: requiredHex(input.blinding, "blinding"),
          commitment: requiredHex(input.commitment, "commitment"),
          ownerDigest: requiredHex(input.ownerDigest, "ownerDigest"),
          rhoDigest: requiredHex(input.rhoDigest, "rhoDigest"),
          tokenDigest: requiredHex(input.tokenDigest, "tokenDigest"),
        });
        return json(proofBundle(prover, record, record.proof));
      }
      if (request.method === "POST" && url.pathname === "/intent-validity") {
        const input = await request.json() as Record<string, unknown>;
        const record = prover.proveIntentValidity({
          assetDigest: requiredHex(input.assetDigest, "assetDigest"),
          blinding: requiredHex(input.blinding, "blinding"),
          changeBlinding: optionalHex(input.changeBlinding) ?? "0x0",
          changeRhoDigest: optionalHex(input.changeRhoDigest) ?? "0x0",
          currentBatch: BigInt(String(input.currentBatch)),
          expiryBatch: BigInt(String(input.expiryBatch)),
          intent: {
            batchId: requiredString(input.batchId, "batchId"),
            limitPrice: BigInt(String(input.limitPrice)),
            margin: BigInt(String(input.margin)),
            marketId: requiredString(input.marketId, "marketId"),
            nonce: requiredString(input.nonce, "nonce"),
            noteNullifier: requiredHex(input.noteNullifier, "noteNullifier"),
            owner: requiredString(input.owner, "owner"),
            salt: requiredString(input.salt, "salt"),
            side: input.side === "short" ? "short" : "long",
            size: BigInt(String(input.size)),
          },
          marginRoot: requiredHex(input.marginRoot, "marginRoot"),
          noteAmount: BigInt(String(input.noteAmount)),
          noteChangeCommitment: optionalHex(input.noteChangeCommitment) ?? "0x0",
          noteCommitment: requiredHex(input.noteCommitment, "noteCommitment"),
          ownerDigest: requiredHex(input.ownerDigest, "ownerDigest"),
          pathIndices: requiredBooleanArray(input.pathIndices, "pathIndices"),
          pathSiblings: requiredHexArray(input.pathSiblings, "pathSiblings"),
          rhoDigest: requiredHex(input.rhoDigest, "rhoDigest"),
          spendSecretDigest: requiredHex(input.spendSecretDigest, "spendSecretDigest"),
        });
        return json(proofBundle(prover, record, record.proof));
      }
      if (request.method === "POST" && url.pathname === "/position-close") {
        const input = await request.json() as Record<string, unknown>;
        const record = prover.provePositionClose({
          blinding: requiredHex(input.blinding, "blinding"),
          closeCommitment: requiredHex(input.closeCommitment, "closeCommitment"),
          closeSize: BigInt(String(input.closeSize)),
          entryPrice: BigInt(String(input.entryPrice)),
          fee: BigInt(String(input.fee)),
          fundingIndex: BigInt(String(input.fundingIndex)),
          fundingPayment: BigInt(String(input.fundingPayment)),
          margin: BigInt(String(input.margin)),
          marginOutputAmount: BigInt(String(input.marginOutputAmount)),
          marginOutputAssetDigest: requiredHex(input.marginOutputAssetDigest, "marginOutputAssetDigest"),
          marginOutputBlinding: requiredHex(input.marginOutputBlinding, "marginOutputBlinding"),
          marginOutputCommitment: requiredHex(input.marginOutputCommitment, "marginOutputCommitment"),
          marginOutputRhoDigest: requiredHex(input.marginOutputRhoDigest, "marginOutputRhoDigest"),
          marketDigest: requiredHex(input.marketDigest, "marketDigest"),
          marketId: requiredString(input.marketId, "marketId"),
          markPrice: BigInt(String(input.markPrice)),
          newMargin: BigInt(String(input.newMargin)),
          newPositionBlinding: requiredHex(input.newPositionBlinding, "newPositionBlinding"),
          newPositionCommitment: requiredHex(input.newPositionCommitment, "newPositionCommitment"),
          newPositionRhoDigest: requiredHex(input.newPositionRhoDigest, "newPositionRhoDigest"),
          newPositionRoot: requiredHex(input.newPositionRoot, "newPositionRoot"),
          ownerDigest: requiredHex(input.ownerDigest, "ownerDigest"),
          pathIndices: requiredBooleanArray(input.pathIndices, "pathIndices"),
          pathSiblings: requiredHexArray(input.pathSiblings, "pathSiblings"),
          positionCommitment: requiredHex(input.positionCommitment, "positionCommitment"),
          positionNullifier: requiredHex(input.positionNullifier, "positionNullifier"),
          positionRoot: requiredHex(input.positionRoot, "positionRoot"),
          remainingMargin: BigInt(String(input.remainingMargin)),
          rhoDigest: requiredHex(input.rhoDigest, "rhoDigest"),
          side: input.side === "short" ? "short" : "long",
          size: BigInt(String(input.size)),
          spendSecretDigest: requiredHex(input.spendSecretDigest, "spendSecretDigest"),
        });
        return json(proofBundle(prover, record, record.proof));
      }
      if (request.method === "POST" && url.pathname === "/withdraw") {
        const input = await request.json() as Record<string, unknown>;
        const record = prover.proveWithdrawal({
          assetDigest: requiredHex(input.assetDigest, "assetDigest"),
          blinding: requiredHex(input.blinding, "blinding"),
          changeBlinding: optionalHex(input.changeBlinding),
          changeRhoDigest: optionalHex(input.changeRhoDigest),
          noteAmount: BigInt(String(input.noteAmount)),
          noteCommitment: requiredHex(input.noteCommitment, "noteCommitment"),
          nullifier: requiredHex(input.nullifier, "nullifier"),
          ownerDigest: requiredHex(input.ownerDigest, "ownerDigest"),
          pathIndices: requiredBooleanArray(input.pathIndices, "pathIndices"),
          pathSiblings: requiredHexArray(input.pathSiblings, "pathSiblings"),
          recipient: requiredHex(input.recipient, "recipient"),
          rhoDigest: requiredHex(input.rhoDigest, "rhoDigest"),
          root: requiredHex(input.root, "root"),
          spendSecretDigest: requiredHex(input.spendSecretDigest, "spendSecretDigest"),
          tokenDigest: requiredHex(input.tokenDigest, "tokenDigest"),
          withdrawAmount: BigInt(String(input.withdrawAmount)),
        });
        return json(proofBundle(prover, record, record.proof));
      }
      return cors(Response.json({ error: "not found" }, { status: 404 }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "local prover error";
      return cors(Response.json({ error: message }, { status: 500 }));
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PNLX_CLIENT_PROVER_PORT ?? DEFAULT_PORT);
  const hostname = process.env.PNLX_CLIENT_PROVER_HOST ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port,
    fetch: createLocalClientProverHandler(process.cwd()),
  });

  console.log(`PNLX local client prover listening on http://${hostname}:${server.port}`);
}

function proofBundle(prover: ProverService, record: unknown, proof: ProofMeta) {
  const artifact = prover.artifactFor(proof);
  if (!artifact) throw new Error("proof artifact not found");
  return {
    artifact: artifactRegistrationBody(proof, artifact),
    record,
  };
}

function artifactRegistrationBody(proof: ProofMeta, artifact: ProofArtifact) {
  return {
    bytecodeHash: artifact.bytecodeHash,
    proof,
    proofBase64: readFileSync(artifact.proofPath).toString("base64"),
    publicInputsBase64: readFileSync(artifact.publicInputsPath).toString("base64"),
    vkBase64: readFileSync(artifact.vkPath).toString("base64"),
    witnessHash: artifact.witnessHash,
  };
}

function json(data: unknown, status = 200): Response {
  return cors(new Response(
    JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  ));
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function requiredString(value: unknown, field: string): string {
  if (value === undefined || value === "") throw new Error(`${field} is required`);
  return String(value);
}

function requiredHex(value: unknown, field: string): `0x${string}` {
  const raw = requiredString(value, field);
  if (!raw.startsWith("0x")) throw new Error(`${field} must be hex`);
  return raw as `0x${string}`;
}

function optionalHex(value: unknown): `0x${string}` | undefined {
  if (value === undefined || value === "") return undefined;
  return requiredHex(value, "hex");
}

function requiredHexArray(value: unknown, field: string): `0x${string}`[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => requiredHex(entry, field));
}

function requiredBooleanArray(value: unknown, field: string): boolean[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => entry === true || entry === "true" || entry === "1");
}
