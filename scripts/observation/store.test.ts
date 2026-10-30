import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationStore, sealState, unsealState } from "./store";

describe("observation financial state", () => {
  const key = Buffer.alloc(32, 7);
  test("authenticates secret state and rejects tampering and the wrong key", () => {
    const secret = { witness: "local-opening-secret", transaction: "signed" };
    const sealed = sealState(secret, key);
    expect(sealed).not.toContain(secret.witness);
    expect(unsealState<typeof secret>(sealed, key)).toEqual(secret);
    expect(() => unsealState(sealed, Buffer.alloc(32, 8))).toThrow();
    const edited = JSON.parse(sealed);
    edited.ciphertext = Buffer.alloc(64).toString("base64");
    expect(() => unsealState(JSON.stringify(edited), key)).toThrow();
  });
  test("serializes durable writes and captures each checkpoint before mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pnlx-observation-"));
    try {
      const store = new ObservationStore<{ version: number }>(join(dir, "state.enc"), key);
      const state = { version: 1 };
      const first = store.write(state);
      state.version = 2;
      const second = store.write(state);
      await Promise.all([first, second]);
      expect(store.read()).toEqual({ version: 2 });
      expect(readFileSync(store.filename, "utf8")).not.toContain('"version":2');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
