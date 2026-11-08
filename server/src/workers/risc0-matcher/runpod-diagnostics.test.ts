import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeRunpodDiagnosticOnce, saveRunpodErrorTrace } from "./runpod-diagnostics";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("diagnostic mode is consumed after one RunPod request", () => {
  const environment = { PNLX_RUNPOD_DIAGNOSTIC_ONCE: "true" };
  expect(consumeRunpodDiagnosticOnce(environment)).toBe(true);
  expect(consumeRunpodDiagnosticOnce(environment)).toBe(false);
  expect(environment.PNLX_RUNPOD_DIAGNOSTIC_ONCE).toBeUndefined();
});

test("trace is saved with private file permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "pnlx-runpod-diagnostic-"));
  tempDirs.push(directory);
  const trace = "synthetic prover failure";
  const path = saveRunpodErrorTrace(directory, trace);
  expect(path).toBe(join(directory, "runpod-error-trace.txt"));
  expect(readFileSync(path!, "utf8")).toBe(trace);
  expect(statSync(path!).mode & 0o777).toBe(0o600);
  expect(saveRunpodErrorTrace(directory, "")).toBeUndefined();
});
