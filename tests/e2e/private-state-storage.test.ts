import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldHex } from "@pnlx/crypto";
import { FileProtocolStore } from "@/shared/state/persistent-store";

test("private state snapshots restrict access and preserve unrelated legacy temporary files", () => {
  const directory = mkdtempSync(join(tmpdir(), "pnlx-private-state-"));
  try {
    const path = join(directory, "private", "state.json");
    const store = new FileProtocolStore(path);
    store.addMarginCommitment(fieldHex(1n));
    expect(statSync(join(directory, "private")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const unrelated = join(directory, "unrelated.txt");
    writeFileSync(unrelated, "preserve this");
    symlinkSync(unrelated, `${path}.tmp`);
    store.addMarginCommitment(fieldHex(2n));
    expect(readFileSync(unrelated, "utf8")).toBe("preserve this");
    expect(readdirSync(join(directory, "private")).sort()).toEqual(["state.json", "state.json.tmp"]);
    expect([...new FileProtocolStore(path).marginCommitments]).toEqual([fieldHex(1n), fieldHex(2n)]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("loading an existing private snapshot tightens its file permissions without changing balances", () => {
  const directory = mkdtempSync(join(tmpdir(), "pnlx-private-state-existing-"));
  try {
    const path = join(directory, "state.json");
    const store = new FileProtocolStore(path);
    store.addMarginCommitment(fieldHex(3n));
    const snapshot = readFileSync(path, "utf8");
    chmodSync(path, 0o644);
    const restored = new FileProtocolStore(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(snapshot);
    expect([...restored.marginCommitments]).toEqual([fieldHex(3n)]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
