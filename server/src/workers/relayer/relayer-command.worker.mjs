import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

const MAX_OUTPUT_LENGTH = 2_000_000;
const DIAGNOSTIC_FLAG = "/tmp/pnlx-stellar-diagnostics-once";
const DIAGNOSTIC_TRACE_FILE = "/tmp/pnlx-stellar-settle-trace.json";

const [rawCommand = "", rawTimeout = ""] = process.argv.slice(2);
const command = parseCommand(rawCommand);
const timeoutMs = parseTimeout(rawTimeout);
const result = run(command, timeoutMs);
process.stdout.write(JSON.stringify(result));

function parseCommand(raw) {
  let value;
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

function parseTimeout(raw) {
  const timeoutMs = Number(raw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("relay worker timeout must be positive");
  }
  return timeoutMs;
}

function run(command, timeoutMs) {
  const sendIndex = command.indexOf("--send");
  const functionIndex = command.indexOf("--") + 1;
  const isBatchSettlement = command[1] === "contract" && command[2] === "invoke" &&
    command[functionIndex] === "settle" && sendIndex >= 0 && command[sendIndex + 1] !== "no";
  const captureDiagnostics = isBatchSettlement && existsSync(DIAGNOSTIC_FLAG);
  if (captureDiagnostics) {
    try {
      unlinkSync(DIAGNOSTIC_FLAG);
    } catch {}
    command.splice(1, 0, "--very-verbose");
  }
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8",
    maxBuffer: 4_000_000,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const timeoutMessage = result.error?.message ?? "";
  // spawnSync returns null stdout/stderr when the child is killed before writing
  // (for example on timeout), so both must be normalized before they are joined.
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (captureDiagnostics && result.status !== 0) {
    const trace = summarizeDiagnosticTrace([stdout, stderr, timeoutMessage].filter(Boolean).join("\n"), result.status);
    writeFileSync(DIAGNOSTIC_TRACE_FILE, JSON.stringify(trace), { encoding: "utf8", mode: 0o600 });
  }
  return {
    status: result.status,
    stderr: boundedOutput([stderr, timeoutMessage].filter(Boolean).join("\n")),
    stdout: boundedOutput(stdout),
  };
}

function summarizeDiagnosticTrace(text, status) {
  const events = [];
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    const eventMatch = line.match(/soroban_cli::log::event:\s*\d+:\s*(?:[A-Za-z0-9+/=]+\s+)?(\{.*\})\s*$/i);
    if (eventMatch) {
      try {
        const record = JSON.parse(eventMatch[1]);
        const event = record.event;
        if (event?.type === "diagnostic") {
          const topics = Array.isArray(event.body?.v0?.topics)
            ? event.body.v0.topics.flatMap((topic) => typeof topic?.symbol === "string" ? [topic.symbol.slice(0, 80)] : [])
            : [];
          events.push({
            successful: record.in_successful_contract_call === true,
            contract: typeof event.contract_id === "string" ? event.contract_id : "unknown",
            topics,
          });
        }
      } catch {}
      continue;
    }
    if (!/TxSoroban|HostError|WasmVm|InvalidAction|trapped|panic|errorResultXdr|diagnosticEventsXdr|transaction submission failed|transaction simulation failed|error:/i.test(line)) continue;
    messages.push(line
      .replace(/(errorResultXdr|diagnosticEventsXdr)(["'\s:=]+)[A-Za-z0-9+/=]+/gi, "$1$2<redacted>")
      .replace(/(?:0x)?[0-9a-f]{40,}/gi, "<redacted-hex>")
      .replace(/[A-Za-z0-9+/=]{40,}/g, "<redacted-xdr>")
      .slice(0, 500));
  }
  return { status, eventCount: events.length, events: events.slice(-80), messages: messages.slice(-30) };
}

function boundedOutput(value) {
  if (typeof value !== "string") return "";
  if (value.length <= MAX_OUTPUT_LENGTH) return value;
  return `${value.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`;
}
