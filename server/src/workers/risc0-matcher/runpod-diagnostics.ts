import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function consumeRunpodDiagnosticOnce(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (environment.PNLX_RUNPOD_DIAGNOSTIC_ONCE !== "true") return false;
  delete environment.PNLX_RUNPOD_DIAGNOSTIC_ONCE;
  return true;
}

export function saveRunpodErrorTrace(directory: string, trace: string): string | undefined {
  if (!trace) return undefined;
  const path = join(directory, "runpod-error-trace.txt");
  writeFileSync(path, trace, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
