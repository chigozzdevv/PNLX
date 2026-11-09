import { describe, expect, test } from "bun:test";
import type { IntentValidityWitness, ProofMeta } from "@pnlx/protocol-types";
import { RemoteIntentValidityProver } from "@/workers/prover/intent-prover";

const proof: ProofMeta = {
  circuitId: "intent-validity",
  circuitKey: "0x01",
  circuitHash: "0x02",
  verifierHash: "0x03",
  publicInputHash: "0x04",
  proofDigest: "0x05",
};

const proofResponse = {
  artifact: {
    proof,
    proofBase64: "cHJvb2Y=",
    publicInputsBase64: "aW5wdXRz",
    vkBase64: "dmVyaWZpZXI=",
    bytecodeHash: "0x06",
    witnessHash: "0x07",
  },
  record: {
    assetDigest: "0x08",
    matchingPayloadCommitment: "0x09",
    ownerDigest: "0x0a",
    positionSeed: "0x0b",
    batchDigest: "0x0c",
    currentBatch: "4",
    expiryBatch: "5",
    intentCommitment: "0x0d",
    marketDigest: "0x0e",
    noteChangeCommitment: "0x0f",
    noteCommitment: "0x10",
    marginRoot: "0x11",
    noteNullifier: "0x12",
    ownerCommitmentField: "0x13",
    proof,
  },
};

describe("remote maker intent-validity prover", () => {
  test("serializes bigint inputs and registers the returned proof artifact", async () => {
    let requestUrl = "";
    let requestBody = "";
    let registered: unknown;
    const input = {
      currentBatch: 1n,
      expiryBatch: 2n,
      noteAmount: 3n,
      intent: { limitPrice: 4n, margin: 5n, size: 6n },
    } as IntentValidityWitness;
    const client = new RemoteIntentValidityProver(
      "http://prover:4101/",
      (artifact) => { registered = artifact; },
      async (url, init) => {
        requestUrl = String(url);
        requestBody = String(init?.body);
        return Response.json(proofResponse);
      },
    );

    const result = await client.prove(input);

    expect(requestUrl).toBe("http://prover:4101/intent-validity");
    expect(JSON.parse(requestBody)).toMatchObject({
      currentBatch: "1",
      expiryBatch: "2",
      noteAmount: "3",
      limitPrice: "4",
      margin: "5",
      size: "6",
    });
    expect(JSON.parse(requestBody).intent).toBeUndefined();
    expect(result.currentBatch).toBe(4n);
    expect(result.expiryBatch).toBe(5n);
    expect(result.proof).toEqual(proof);
    expect(registered).toMatchObject({ proof, proofBase64: "cHJvb2Y=" });
  });

  test("does not expose a prover error response body", async () => {
    const privateInput = "private-witness-value";
    const client = new RemoteIntentValidityProver(
      "http://prover:4101",
      () => { throw new Error("artifact must not register"); },
      async () => new Response(JSON.stringify({ error: privateInput }), { status: 500 }),
    );

    let message = "";
    try {
      await client.prove({} as IntentValidityWitness);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("prover service failed with status 500");
    expect(message).not.toContain(privateInput);
  });

  test("rejects mismatched record proof metadata before artifact registration", async () => {
    let registered = false;
    const body = structuredClone(proofResponse);
    body.record.proof = { ...proof };
    body.record.proof.proofDigest = "0xff";
    const client = new RemoteIntentValidityProver(
      "http://prover:4101",
      () => { registered = true; },
      async () => Response.json(body),
    );

    await expect(client.prove({} as IntentValidityWitness)).rejects.toThrow("proof metadata mismatch");
    expect(registered).toBe(false);
  });
});
