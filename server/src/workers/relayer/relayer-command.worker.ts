import { spawnSync } from "node:child_process";
import type { CommandResult } from "@/workers/relayer/relayer.model";

const MAX_OUTPUT_LENGTH = 256_000;

const [rawCommand = "", rawTimeout = ""] = process.argv.slice(2);
const command = parseCommand(rawCommand);
const timeoutMs = parseTimeout(rawTimeout);
const result = run(command, timeoutMs);
process.stdout.write(JSON.stringify(result));

function parseCommand(raw: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("relay worker command must be valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    throw new Error("relay worker command must be a non-empty string array");
  }
  if (value[0] !== "stellar") {
    throw new Error("relay worker only accepts stellar commands");
  }
  return value;
}

function parseTimeout(raw: string): number {
  const timeoutMs = Number(raw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("relay worker timeout must be positive");
  }
  return timeoutMs;
}

function run(command: string[], timeoutMs: number): CommandResult {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const timeoutMessage = result.error?.message ?? "";
  return {
    status: result.status,
    stderr: boundedOutput([result.stderr, timeoutMessage].filter(Boolean).join("\n")),
    stdout: boundedOutput(result.stdout),
  };
}

function boundedOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_LENGTH) return value;
  return `${value.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`;
}
