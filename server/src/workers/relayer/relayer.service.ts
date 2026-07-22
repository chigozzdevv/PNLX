import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { hashFields } from "@pnlx/crypto";
import type {
  CommandResult,
  CommandRunner,
  ContractReadResult,
  RelayedTx,
  PreparedXdr,
  RelayRequest,
  SignedXdrRelayInput,
  StellarInvokePayload,
  StellarRelayerConfig,
} from "@/workers/relayer/relayer.model";

export class RelayerService {
  private readonly sent: RelayedTx[] = [];
  private readonly runCommand: CommandRunner;
  private readonly usesDefaultCommandRunner: boolean;

  constructor(
    private readonly config: StellarRelayerConfig = {
      mode: "local",
      network: "testnet",
      source: "pnlx-testnet",
    },
    runCommand?: CommandRunner,
  ) {
    this.usesDefaultCommandRunner = !runCommand;
    this.runCommand = runCommand ?? ((command, args) =>
      defaultCommandRunner(command, args, this.commandTimeoutMs()));
  }

  relay(request: RelayRequest): RelayedTx {
    const payloadDigest = hashFields("relay-payload", [request.kind, request.payload]);
    const command = this.config.mode === "stellar-cli" ? stellarInvokeCommand(this.config, request.payload) : undefined;
    const invokePayload = command ? parseInvokePayload(request.payload) : undefined;
    const output = command ? runCommandWithRetry(this.runCommand, command) : undefined;
    const commandOutputDigest = output
      ? hashFields("relay-command-output", [payloadDigest, output.status ?? "null", output.stdout, output.stderr])
      : undefined;
    const sendMode = command ? commandSendMode(command) : undefined;
    if (output && output.status !== 0) {
      throw new Error(`stellar relay failed (${relayTarget(request.kind, invokePayload)}): ${formatStellarFailure(output)}`);
    }
    const txHash = output ? parseTxHash(commandOutput(output)) : undefined;
    if (command && output?.status === 0 && sendsTransaction(command) && !txHash) {
      throw new Error("stellar relay did not return a transaction hash");
    }
    if (command && output?.status === 0 && this.usesDefaultCommandRunner && sendsTransaction(command)) {
      sleep(3_500);
    }
    const tx: RelayedTx = {
      command,
      commandOutputDigest,
      commandStatus: output?.status,
      contractId: invokePayload?.contractId,
      functionName: invokePayload?.functionName,
      relayId: hashFields("relay-id", [request.kind, payloadDigest, this.sent.length]),
      kind: request.kind,
      mode: this.config.mode,
      payloadDigest,
      sendMode,
      submittedAt: Date.now(),
      submitted: Boolean(txHash && command && sendsTransaction(command)),
      txHash,
    };
    this.sent.push(tx);
    return tx;
  }

  async relayAsync(request: RelayRequest): Promise<RelayedTx> {
    if (this.config.mode !== "stellar-cli" || !this.usesDefaultCommandRunner) {
      return this.relay(request);
    }
    const payloadDigest = hashFields("relay-payload", [request.kind, request.payload]);
    const command = stellarInvokeCommand(this.config, request.payload);
    const invokePayload = parseInvokePayload(request.payload);
    const output = await runCommandWithRetryAsync(command, this.commandTimeoutMs());
    const commandOutputDigest = hashFields(
      "relay-command-output",
      [payloadDigest, output.status ?? "null", output.stdout, output.stderr],
    );
    const sendMode = commandSendMode(command);
    if (output.status !== 0) {
      throw new Error(`stellar relay failed (${relayTarget(request.kind, invokePayload)}): ${formatStellarFailure(output)}`);
    }
    const txHash = parseTxHash(commandOutput(output));
    if (sendsTransaction(command) && !txHash) {
      throw new Error("stellar relay did not return a transaction hash");
    }
    if (sendsTransaction(command)) await delay(3_500);
    const tx: RelayedTx = {
      command,
      commandOutputDigest,
      commandStatus: output.status,
      contractId: invokePayload.contractId,
      functionName: invokePayload.functionName,
      relayId: hashFields("relay-id", [request.kind, payloadDigest, this.sent.length]),
      kind: request.kind,
      mode: this.config.mode,
      payloadDigest,
      sendMode,
      submittedAt: Date.now(),
      submitted: Boolean(txHash && sendsTransaction(command)),
      txHash,
    };
    this.sent.push(tx);
    return tx;
  }

  private commandTimeoutMs(): number {
    return this.config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  submitSignedXdr(input: SignedXdrRelayInput): RelayedTx {
    const payloadDigest = hashFields("signed-xdr-payload", [input.xdr]);
    const command = this.config.mode === "stellar-cli" ? stellarTxSendCommand(this.config, input.xdr) : undefined;
    const signedTxHash = command
      ? hashTransactionXdr(this.config, input.xdr, this.runCommand, "signed transaction")
      : undefined;
    if (input.expectedTxHash && signedTxHash && input.expectedTxHash !== signedTxHash) {
      throw new Error("Signed transaction does not match prepared transaction");
    }
    const output = command ? runCommandWithRetry(this.runCommand, command) : undefined;
    const commandOutputDigest = output
      ? hashFields("relay-command-output", [payloadDigest, output.status ?? "null", output.stdout, output.stderr])
      : undefined;
    if (output && output.status !== 0) {
      throw new Error(`Transaction rejected by Stellar: ${formatStellarFailure(output)}`);
    }
    const txHash = output ? parseTxHash(commandOutput(output)) : undefined;
    if (command && output?.status === 0 && !txHash) {
      throw new Error("stellar relay did not return a transaction hash");
    }
    if (command && output?.status === 0 && this.runCommand === defaultCommandRunner) {
      sleep(3_500);
    }
    const tx: RelayedTx = {
      command: command ? redactSignedXdrCommand(command) : undefined,
      commandOutputDigest,
      commandStatus: output?.status,
      commitment: input.commitment,
      functionName: "tx send",
      relayId: hashFields("relay-id", ["signed-xdr", payloadDigest, this.sent.length]),
      kind: "signed-xdr",
      mode: this.config.mode,
      payloadDigest,
      preparedXdrDigest: input.preparedXdrDigest,
      sendMode: command ? "yes" : undefined,
      submittedBy: input.submittedBy,
      submittedAt: Date.now(),
      submitted: Boolean(txHash && command),
      txHash,
    };
    this.sent.push(tx);
    return tx;
  }

  prepare(request: RelayRequest): string[] {
    return stellarInvokeCommand(this.config, request.payload);
  }

  read(request: RelayRequest): ContractReadResult {
    if (this.config.mode !== "stellar-cli") {
      throw new Error("stellar-cli relayer mode is required to read contract state");
    }
    const payload = parseInvokePayload(request.payload);
    const command = stellarInvokeCommand(this.config, { ...payload, send: "no" });
    if (commandSendMode(command) !== "no") {
      throw new Error("contract reads require --send no");
    }
    const output = runCommandWithRetry(this.runCommand, command);
    const payloadDigest = hashFields("relay-payload", [request.kind, request.payload]);
    const commandOutputDigest = hashFields(
      "relay-command-output",
      [payloadDigest, output.status ?? "null", output.stdout, output.stderr],
    );
    if (output.status !== 0) {
      throw new Error(`stellar contract read failed: ${formatStellarFailure(output)}`);
    }
    return {
      command,
      commandOutputDigest,
      commandStatus: output.status,
      output: commandOutput(output),
    };
  }

  async readAsync(request: RelayRequest): Promise<ContractReadResult> {
    if (this.config.mode !== "stellar-cli" || !this.usesDefaultCommandRunner) {
      return this.read(request);
    }
    const payload = parseInvokePayload(request.payload);
    const command = stellarInvokeCommand(this.config, { ...payload, send: "no" });
    if (commandSendMode(command) !== "no") {
      throw new Error("contract reads require --send no");
    }
    const output = await runCommandWithRetryAsync(command, this.commandTimeoutMs());
    const payloadDigest = hashFields("relay-payload", [request.kind, request.payload]);
    const commandOutputDigest = hashFields(
      "relay-command-output",
      [payloadDigest, output.status ?? "null", output.stdout, output.stderr],
    );
    if (output.status !== 0) {
      throw new Error(`stellar contract read failed: ${formatStellarFailure(output)}`);
    }
    return {
      command,
      commandOutputDigest,
      commandStatus: output.status,
      output: commandOutput(output),
    };
  }

  prepareXdr(request: RelayRequest): PreparedXdr {
    if (this.config.mode !== "stellar-cli") {
      throw new Error("stellar-cli relayer mode is required to build wallet transaction xdr");
    }
    const command = stellarInvokeCommand(this.config, request.payload);
    if (commandSendMode(command) !== "no" || !command.includes("--build-only")) {
      throw new Error("wallet transaction preparation requires --send no --build-only");
    }
    const output = runCommandWithRetry(this.runCommand, command);
    const payloadDigest = hashFields("relay-payload", [request.kind, request.payload]);
    if (output.status !== 0) {
      throw new Error(`stellar transaction build failed: ${output.stderr || output.stdout || output.status}`);
    }
    const builtXdr = parseBuiltXdr(output.stdout);
    if (!builtXdr) throw new Error("stellar transaction build did not return xdr");
    const source = parseInvokePayload(request.payload).source ?? this.config.source;
    const assembleCommand = stellarTxSimulateCommand(this.config, builtXdr, source);
    const assembledOutput = runCommandWithRetry(this.runCommand, assembleCommand);
    const commandOutputDigest = hashFields(
      "relay-command-output",
      [
        payloadDigest,
        output.status ?? "null",
        output.stdout,
        output.stderr,
        assembledOutput.status ?? "null",
        assembledOutput.stdout,
        assembledOutput.stderr,
      ],
    );
    if (assembledOutput.status !== 0) {
      throw new Error(`stellar transaction simulation failed: ${formatStellarFailure(assembledOutput)}`);
    }
    const xdr = parseBuiltXdr(assembledOutput.stdout);
    if (!xdr) throw new Error("stellar transaction simulation did not return assembled xdr");
    const txHash = hashTransactionXdr(this.config, xdr, this.runCommand, "prepared transaction");
    return {
      command,
      commandOutputDigest,
      commandStatus: output.status,
      txHash,
      xdr,
    };
  }

  list(): RelayedTx[] {
    return [...this.sent];
  }

  find(relayId: `0x${string}`): RelayedTx | undefined {
    return this.sent.find((tx) => tx.relayId === relayId);
  }
}

function relayTarget(kind: RelayRequest["kind"], payload: StellarInvokePayload | undefined): string {
  if (!payload) return kind;
  return `${kind} ${payload.functionName} on ${payload.contractId}`;
}

function stellarInvokeCommand(config: StellarRelayerConfig, rawPayload: unknown): string[] {
  const payload = parseInvokePayload(rawPayload);
  const send = payload.send ?? (payload.buildOnly ? "no" : "yes");
  return [
    "stellar",
    "contract",
    "invoke",
    "--id",
    payload.contractId,
    "--source",
    payload.source ?? config.source,
    "--network",
    config.network,
    ...networkArgs(config),
    "--send",
    send,
    ...(payload.buildOnly ? ["--build-only"] : []),
    ...(payload.autoSign === false || payload.buildOnly ? [] : ["--auto-sign"]),
    "--",
    payload.functionName,
    ...(payload.args ?? []),
  ];
}

function stellarTxSendCommand(config: StellarRelayerConfig, xdr: string): string[] {
  return [
    "stellar",
    "tx",
    "send",
    xdr,
    "--network",
    config.network,
    ...networkArgs(config),
  ];
}

function stellarTxHashCommand(config: StellarRelayerConfig, xdr: string): string[] {
  return [
    "stellar",
    "tx",
    "hash",
    xdr,
    "--network",
    config.network,
    ...networkArgs(config),
  ];
}

function stellarTxSimulateCommand(config: StellarRelayerConfig, xdr: string, source: string): string[] {
  return [
    "stellar",
    "tx",
    "simulate",
    xdr,
    "--source-account",
    source,
    "--network",
    config.network,
    ...networkArgs(config),
  ];
}

function networkArgs(config: StellarRelayerConfig): string[] {
  return [
    ...(config.rpcUrl ? ["--rpc-url", config.rpcUrl] : []),
    ...(config.networkPassphrase ? ["--network-passphrase", config.networkPassphrase] : []),
  ];
}

function parseInvokePayload(payload: unknown): StellarInvokePayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("stellar relay payload must be an object");
  }

  const candidate = payload as Partial<StellarInvokePayload>;
  if (!candidate.contractId || !candidate.functionName) {
    throw new Error("stellar relay payload requires contractId and functionName");
  }
  if (candidate.args && !Array.isArray(candidate.args)) {
    throw new Error("stellar relay payload args must be an array");
  }
  if (candidate.send && !["default", "no", "yes"].includes(candidate.send)) {
    throw new Error("stellar relay payload send must be default, no, or yes");
  }

  return {
    args: candidate.args?.map(String),
    autoSign: candidate.autoSign,
    buildOnly: candidate.buildOnly,
    contractId: String(candidate.contractId),
    functionName: String(candidate.functionName),
    send: candidate.send,
    source: candidate.source ? String(candidate.source) : undefined,
  };
}

const DEFAULT_COMMAND_TIMEOUT_MS = 45_000;
const RELAYER_COMMAND_WORKER = new URL("./relayer-command.worker.mjs", import.meta.url).pathname;

function defaultCommandRunner(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs });
  return {
    status: result.status,
    stderr: result.error?.message
      ? `${result.stderr}${result.stderr ? "\n" : ""}${result.error.message}`
      : result.stderr,
    stdout: result.stdout,
  };
}

function runCommandWithRetry(runCommand: CommandRunner, command: string[]): CommandResult {
  let output = runCommand(command[0], command.slice(1));
  for (let attempt = 1; attempt < 4 && isTransientStellarFailure(output); attempt += 1) {
    sleep(2_500 * attempt);
    output = runCommand(command[0], command.slice(1));
  }
  return output;
}

async function runCommandWithRetryAsync(
  command: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  let output = await runCommandAsync(command, timeoutMs);
  for (let attempt = 1; attempt < 4 && isTransientStellarFailure(output); attempt += 1) {
    await delay(2_500 * attempt);
    output = await runCommandAsync(command, timeoutMs);
  }
  return output;
}

function runCommandAsync(command: string[], timeoutMs: number): Promise<CommandResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([
      nodeRuntime(),
      RELAYER_COMMAND_WORKER,
      JSON.stringify(command),
      String(timeoutMs),
    ], {
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
  } catch (error) {
    return Promise.resolve({
      status: null,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    });
  }

  let timedOut = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    forceKill.unref?.();
  }, timeoutMs + 2_000);
  timeout.unref?.();

  return Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]).then(([stdout, rawStderr, status]) => {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
    if (timedOut) {
      return {
        status: null,
        stderr: [rawStderr, `stellar command timed out after ${timeoutMs}ms`].filter(Boolean).join("\n"),
        stdout: "",
      };
    }
    if (status !== 0) {
      return { status, stderr: rawStderr || stdout, stdout: "" };
    }
    return parseRelayWorkerResult(stdout);
  });
}

let resolvedNodeRuntime: string | undefined;

function nodeRuntime(): string {
  if (resolvedNodeRuntime) return resolvedNodeRuntime;
  const currentRuntime = realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "node");
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (resolved !== currentRuntime) {
        resolvedNodeRuntime = resolved;
        return resolved;
      }
    } catch {
      // Continue until a distinct executable Node.js runtime is found.
    }
  }
  throw new Error("a standalone Node.js runtime is required for async Stellar relay");
}

function parseRelayWorkerResult(output: string): CommandResult {
  try {
    const parsed = JSON.parse(output) as Partial<CommandResult>;
    if (
      (typeof parsed.status !== "number" && parsed.status !== null) ||
      typeof parsed.stderr !== "string" ||
      typeof parsed.stdout !== "string"
    ) throw new Error("invalid relay worker result");
    return {
      status: parsed.status,
      stderr: parsed.stderr,
      stdout: parsed.stdout,
    };
  } catch (error) {
    return {
      status: null,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashTransactionXdr(
  config: StellarRelayerConfig,
  xdr: string,
  runCommand: CommandRunner,
  label: string,
): `0x${string}` {
  const command = stellarTxHashCommand(config, xdr);
  const output = runCommand(command[0], command.slice(1));
  if (output.status !== 0) {
    throw new Error(`${label} XDR is malformed: ${formatStellarFailure(output)}`);
  }
  const txHash = parseTxHash(commandOutput(output));
  if (!txHash) {
    throw new Error(`${label} XDR hash was not returned`);
  }
  return txHash;
}

function isTransientStellarFailure(output: CommandResult): boolean {
  if (output.status === 0) return false;
  const text = `${output.stdout}\n${output.stderr}`.toLowerCase();
  return text.includes("txbadseq") ||
    text.includes("tx_bad_seq") ||
    text.includes("try_again_later") ||
    text.includes("timeout") ||
    text.includes("rate limit");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sendsTransaction(command: string[]): boolean {
  return commandSendMode(command) === "yes";
}

function commandSendMode(command: string[]): "yes" | "no" | undefined {
  const sendIndex = command.indexOf("--send");
  const value = sendIndex >= 0 ? command[sendIndex + 1] : undefined;
  return value === "yes" || value === "no" ? value : undefined;
}

function commandOutput(output: CommandResult): string {
  return [output.stdout, output.stderr].filter(Boolean).join("\n");
}

function redactSignedXdrCommand(command: string[]): string[] {
  const txXdrIndex = command.findIndex((_, index) =>
    index >= 2 && command[index - 2] === "tx" && command[index - 1] === "send",
  );
  if (txXdrIndex < 0) return [...command];
  return command.map((part, index) => (index === txXdrIndex ? "<signed-xdr-redacted>" : part));
}

function formatStellarFailure(output: CommandResult): string {
  const text = commandOutput(output).trim();
  if (text.includes("Contract, #13") || text.includes("TrustlineMissingError")) {
    return "USDC trustline is missing for this wallet";
  }
  const reason = text.match(/transaction submission failed:\s*([^\n\r]+)/i)?.[1]?.trim() ??
    text.match(/transaction simulation failed:\s*([^\n\r]+)/i)?.[1]?.trim() ??
    text.match(/error:\s*([^\n\r]+)/i)?.[1]?.trim();
  if (reason) return reason;
  return text || String(output.status ?? "unknown stellar cli failure");
}

function parseTxHash(output: string): `0x${string}` | undefined {
  const fromJson = txHashFromJson(output);
  if (fromJson) return fromJson;

  const match = output.match(/(?:^|[^0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?:$|[^0-9a-fA-F])/);
  return match ? `0x${match[1].toLowerCase()}` : undefined;
}

function txHashFromJson(output: string): `0x${string}` | undefined {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;

  try {
    return findTxHash(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function findTxHash(value: unknown): `0x${string}` | undefined {
  if (typeof value === "string") {
    const match = value.match(/^(?:0x)?([0-9a-fA-F]{64})$/);
    return match ? `0x${match[1].toLowerCase()}` : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTxHash(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["hash", "txHash", "transactionHash", "transaction_hash", "id"] as const) {
    const found = findTxHash(record[key]);
    if (found) return found;
  }
  for (const nested of Object.values(record)) {
    const found = findTxHash(nested);
    if (found) return found;
  }
  return undefined;
}

function parseBuiltXdr(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^[A-Za-z0-9+/=]+$/.test(line) && line.length > 16);
}
