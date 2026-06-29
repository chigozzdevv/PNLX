import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashFields } from "@merkl/crypto";
import type {
  CommandResult,
  CommandRunner,
  RelayedTx,
  PreparedXdr,
  RelayRequest,
  SignedXdrRelayInput,
  StellarInvokePayload,
  StellarRelayerConfig,
} from "@/workers/relayer/relayer.model";

export class RelayerService {
  private readonly sent: RelayedTx[] = [];

  constructor(
    private readonly config: StellarRelayerConfig = {
      mode: "local",
      network: "testnet",
      source: "merkl-testnet",
    },
    private readonly runCommand: CommandRunner = defaultCommandRunner,
    private readonly historyPath?: string,
  ) {
    this.load();
  }

  relay(request: RelayRequest): RelayedTx {
    const payloadDigest = hashFields("relay-payload", [request.kind, request.payload]);
    const command = this.config.mode === "stellar-cli" ? stellarInvokeCommand(this.config, request.payload) : undefined;
    const output = command ? runCommandWithRetry(this.runCommand, command) : undefined;
    const commandOutputDigest = output
      ? hashFields("relay-command-output", [payloadDigest, output.status ?? "null", output.stdout, output.stderr])
      : undefined;
    const sendMode = command ? commandSendMode(command) : undefined;
    if (output && output.status !== 0) {
      throw new Error(`stellar relay failed: ${output.stderr || output.stdout || output.status}`);
    }
    const txHash = output ? parseTxHash(output.stdout) : undefined;
    if (command && output?.status === 0 && sendsTransaction(command) && !txHash) {
      throw new Error("stellar relay did not return a transaction hash");
    }
    if (command && output?.status === 0 && this.runCommand === defaultCommandRunner && sendsTransaction(command)) {
      sleep(3_500);
    }
    const tx: RelayedTx = {
      command,
      commandOutputDigest,
      commandStatus: output?.status,
      contractId: command ? parseInvokePayload(request.payload).contractId : undefined,
      functionName: command ? parseInvokePayload(request.payload).functionName : undefined,
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
    this.save();
    return tx;
  }

  submitSignedXdr(input: SignedXdrRelayInput): RelayedTx {
    const payloadDigest = hashFields("signed-xdr-payload", [input.xdr]);
    const command = this.config.mode === "stellar-cli" ? stellarTxSendCommand(this.config, input.xdr) : undefined;
    const output = command ? runCommandWithRetry(this.runCommand, command) : undefined;
    const commandOutputDigest = output
      ? hashFields("relay-command-output", [payloadDigest, output.status ?? "null", output.stdout, output.stderr])
      : undefined;
    if (output && output.status !== 0) {
      throw new Error(`stellar signed transaction relay failed: ${output.stderr || output.stdout || output.status}`);
    }
    const txHash = output ? parseTxHash(output.stdout) : undefined;
    if (command && output?.status === 0 && !txHash) {
      throw new Error("stellar relay did not return a transaction hash");
    }
    if (command && output?.status === 0 && this.runCommand === defaultCommandRunner) {
      sleep(3_500);
    }
    const tx: RelayedTx = {
      command,
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
    this.save();
    return tx;
  }

  prepare(request: RelayRequest): string[] {
    return stellarInvokeCommand(this.config, request.payload);
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
    const commandOutputDigest = hashFields(
      "relay-command-output",
      [payloadDigest, output.status ?? "null", output.stdout, output.stderr],
    );
    if (output.status !== 0) {
      throw new Error(`stellar transaction build failed: ${output.stderr || output.stdout || output.status}`);
    }
    const xdr = parseBuiltXdr(output.stdout);
    if (!xdr) throw new Error("stellar transaction build did not return xdr");
    return {
      command,
      commandOutputDigest,
      commandStatus: output.status,
      xdr,
    };
  }

  list(): RelayedTx[] {
    return [...this.sent];
  }

  find(relayId: `0x${string}`): RelayedTx | undefined {
    return this.sent.find((tx) => tx.relayId === relayId);
  }

  private load(): void {
    if (!this.historyPath || !existsSync(this.historyPath)) return;

    const snapshot = JSON.parse(readFileSync(this.historyPath, "utf8")) as Partial<{
      sent: Array<Partial<RelayedTx> & Pick<RelayedTx, "kind" | "payloadDigest" | "relayId" | "submittedAt">>;
    }>;
    this.sent.splice(0, this.sent.length, ...(snapshot.sent ?? []).map((tx) => ({
      ...tx,
      mode: tx.mode ?? (tx.command ? "stellar-cli" : "local"),
      submitted: tx.submitted ?? Boolean(tx.txHash),
    })));
  }

  private save(): void {
    if (!this.historyPath) return;

    mkdirSync(dirname(this.historyPath), { recursive: true });
    const tempPath = `${this.historyPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ sent: this.sent }, null, 2));
    renameSync(tempPath, this.historyPath);
  }
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

function defaultCommandRunner(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stderr: result.stderr,
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

function parseTxHash(output: string): `0x${string}` | undefined {
  const match = output.match(/\b[0-9a-f]{64}\b/i);
  return match ? `0x${match[0].toLowerCase()}` : undefined;
}

function parseBuiltXdr(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^[A-Za-z0-9+/=]+$/.test(line) && line.length > 16);
}
