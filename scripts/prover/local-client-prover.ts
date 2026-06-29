import { readFileSync } from "node:fs";
import { ProverService } from "@/workers/prover/prover.service";
import type { ProofMeta } from "@merkl/protocol-types";
import type { ProofArtifact } from "@merkl/proof-system";

const DEFAULT_PORT = 4101;

export function createLocalClientProverHandler(root = process.cwd()) {
  const prover = new ProverService(root);
  return async function handleLocalClientProver(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "merkl-local-client-prover" });
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
          noteCommitment: requiredHex(input.noteCommitment, "noteCommitment"),
          ownerDigest: requiredHex(input.ownerDigest, "ownerDigest"),
          pathIndices: requiredBooleanArray(input.pathIndices, "pathIndices"),
          pathSiblings: requiredHexArray(input.pathSiblings, "pathSiblings"),
          rhoDigest: requiredHex(input.rhoDigest, "rhoDigest"),
          spendSecretDigest: requiredHex(input.spendSecretDigest, "spendSecretDigest"),
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
  const port = Number(process.env.MERKL_CLIENT_PROVER_PORT ?? DEFAULT_PORT);
  const server = Bun.serve({
    port,
    fetch: createLocalClientProverHandler(process.cwd()),
  });

  console.log(`Merkl local client prover listening on http://127.0.0.1:${server.port}`);
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

function requiredHexArray(value: unknown, field: string): `0x${string}`[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => requiredHex(entry, field));
}

function requiredBooleanArray(value: unknown, field: string): boolean[] {
  if (!Array.isArray(value)) throw new Error(`${field} is required`);
  return value.map((entry) => entry === true || entry === "true" || entry === "1");
}
