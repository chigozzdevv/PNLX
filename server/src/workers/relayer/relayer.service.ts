import { execFile, spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { hashFields } from "@pnlx/crypto";
import type {
  AsyncCommandRunner,
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
    private readonly asyncCommandRunner?: AsyncCommandRunner,
  ) {
    if (config.commandTimeoutMs !== undefined && (!Number.isSafeInteger(config.commandTimeoutMs) || config.commandTimeoutMs <= 0)) {
      throw new Error("relayer command timeout must be a positive safe integer");
    }
    this.usesDefaultCommandRunner = !runCommand;
    this.runCommand = runCommand ?? ((command, args) =>
      defaultCommandRunner(command, args, this.commandTimeoutMs()));
  }

  relay(request: RelayRequest): RelayedTx {
    throwIfAborted(request.signal);
    const source = this.config.mode === "stellar-cli" ? parseInvokePayload(request.payload).source : undefined;
    if (this.config.mode === "stellar-cli" && sendsTransaction(stellarInvokeCommand(this.config, request.payload))) {
      this.assertSourceAvailable(source);
    }
    return this.relayUnqueued(request);
  }

  private relayUnqueued(request: RelayRequest): RelayedTx {
    throwIfAborted(request.signal);
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
    throwIfAborted(request.signal);
    if (this.config.mode !== "stellar-cli") return this.relayUnqueued(request);
    const payload = parseInvokePayload(request.payload);
    const command = stellarInvokeCommand(this.config, payload);
    const work = () => this.relayAsyncUnqueued(request);
    return sendsTransaction(command)
      ? queueSubmission(this.sourceKey(payload.source), request.signal, work)
      : work();
  }

  private async relayAsyncUnqueued(request: RelayRequest): Promise<RelayedTx> {
    throwIfAborted(request.signal);
    const payloadDigest = hashFields("relay-payload", [request.kind, request.payload]);
    const command = stellarInvokeCommand(this.config, request.payload);
    const invokePayload = parseInvokePayload(request.payload);
    const output = await runCommandWithRetryAsync(command, this.commandTimeoutMs(), this.commandRunnerAsync(), request.signal);
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
    if (this.usesDefaultCommandRunner && !this.asyncCommandRunner && sendsTransaction(command)) await delay(3_500);
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

  async relayJournaled(
    request: RelayRequest,
    beforeSubmit: (prepared: { txHash: `0x${string}`; xdr: string }) => Promise<void>,
    prepared?: { txHash: `0x${string}`; xdr: string },
  ): Promise<RelayedTx> {
    if (this.config.mode !== "stellar-cli") throw new Error("journaled relay requires stellar-cli mode");
    throwIfAborted(request.signal);
    const payload = parseInvokePayload(request.payload);
    return queueSubmission(this.sourceKey(payload.source), request.signal, async () => {
      const runner = this.commandRunnerAsync();
      let xdr: string;
      if (prepared) xdr = prepared.xdr;
      else {
        const source = payload.source ?? this.config.source;
        const build = stellarInvokeCommand(this.config, { ...payload, send: "no", buildOnly: true });
        const built = await runCommandWithRetryAsync(build, this.commandTimeoutMs(), runner, request.signal);
        if (built.status !== 0) throw new Error(`journaled transaction build failed: ${formatStellarFailure(built)}`);
        const builtXdr = parseBuiltXdr(built.stdout);
        if (!builtXdr) throw new Error("journaled transaction build did not return XDR");
        const simulate = stellarTxSimulateCommand(this.config, builtXdr, source);
        const simulated = await runCommandWithRetryAsync(simulate, this.commandTimeoutMs(), runner, request.signal);
        if (simulated.status !== 0) throw new Error(`journaled transaction simulation failed: ${formatStellarFailure(simulated)}`);
        const assembledXdr = parseBuiltXdr(simulated.stdout);
        if (!assembledXdr) throw new Error("journaled transaction simulation did not return XDR");
        const sign = ["stellar", "tx", "sign", assembledXdr, "--sign-with-key", source,
          "--network", this.config.network, ...networkArgs(this.config)];
        const signed = await runCommandWithRetryAsync(sign, this.commandTimeoutMs(), runner, request.signal);
        if (signed.status !== 0) throw new Error("journaled transaction signing failed");
        const signedXdr = parseBuiltXdr(signed.stdout);
        if (!signedXdr) throw new Error("journaled transaction signing did not return XDR");
        xdr = signedXdr;
      }
      const hashCommand = stellarTxHashCommand(this.config, xdr);
      const hashed = await runCommandWithRetryAsync(hashCommand, this.commandTimeoutMs(), runner, request.signal);
      const txHash = hashed.status === 0 ? parseTxHash(commandOutput(hashed)) : undefined;
      if (!txHash) throw new Error("journaled transaction hash was not returned");
      if (prepared && txHash.toLowerCase() !== prepared.txHash.toLowerCase()) {
        throw new Error("resumed XDR does not match the journaled transaction hash");
      }
      throwIfAborted(request.signal);
      await beforeSubmit({ txHash, xdr });
      throwIfAborted(request.signal);
      const command = stellarTxSendCommand(this.config, xdr);
      // Persisted XDR/hash identify this exact transaction even when the response is lost.
      let output: CommandResult;
      try { output = await runner(command[0], command.slice(1), this.commandTimeoutMs()); }
      catch { throw new JournaledRelayError(txHash, "journaled transaction response lost; reconciliation required"); }
      const returnedHash = parseTxHash(commandOutput(output));
      if (output.status !== 0 || returnedHash !== txHash) {
        throw new JournaledRelayError(txHash, output.status !== 0
          ? "journaled transaction response uncertain; reconcile the prepared transaction hash"
          : "journaled transaction returned an unexpected hash; reconciliation required");
      }
      const payloadDigest = hashFields("relay-payload", [request.kind, request.payload]);
      const tx: RelayedTx = {
        command: redactSignedXdrCommand(command),
        commandOutputDigest: hashFields("relay-command-output", [payloadDigest, output.status, output.stdout, output.stderr]),
        commandStatus: output.status,
        contractId: payload.contractId,
        functionName: payload.functionName,
        relayId: hashFields("relay-id", [request.kind, payloadDigest, this.sent.length]),
        kind: request.kind, mode: this.config.mode, payloadDigest,
        sendMode: "yes", submittedAt: Date.now(), submitted: true, txHash,
      };
      this.sent.push(tx);
      return tx;
    });
  }

  async readTransactionStatus(txHash: `0x${string}`): Promise<"SUCCESS" | "FAILED" | "NOT_FOUND"> {
    if (!/^0x[0-9a-f]{64}$/i.test(txHash)) throw new Error("invalid transaction hash");
    const body = await this.readRpcResult("getTransaction", { hash: txHash.slice(2) });
    const status = body.status;
    if (status !== "SUCCESS" && status !== "FAILED" && status !== "NOT_FOUND") {
      throw new Error("transaction reconciliation returned an invalid status");
    }
    return status;
  }

  async findContractEventTransaction(
    contractId: string, ledger: number, closeCommitment: `0x${string}`,
  ): Promise<`0x${string}`> {
    if (!/^C[A-Z2-7]{55}$/.test(contractId)) throw new Error("invalid event contract address");
    if (!Number.isSafeInteger(ledger) || ledger < 1 || ledger >= 0xffff_ffff) throw new Error("invalid event ledger");
    if (!/^0x[0-9a-f]{64}$/i.test(closeCommitment)) throw new Error("invalid close commitment");
    const commitmentTopic = scValOpaqueTopic(13, Buffer.from(closeCommitment.slice(2), "hex"));
    const kindTopic = scValOpaqueTopic(15, Buffer.from("pairclose", "ascii"));
    const limit = 1_000;
    const result = await this.readRpcResult("getEvents", {
      startLedger: ledger, endLedger: ledger + 1,
      filters: [{ type: "contract", contractIds: [contractId], topics: [[kindTopic, commitmentTopic]] }],
      pagination: { limit }, xdrFormat: "base64",
    });
    if (!Number.isSafeInteger(result.oldestLedger) || !Number.isSafeInteger(result.latestLedger) ||
      (result.oldestLedger as number) > ledger || (result.latestLedger as number) < ledger) {
      throw new Error("event ledger is outside retained RPC history; reconciliation required");
    }
    if (!Array.isArray(result.events) || result.events.length >= limit) {
      throw new Error("event reconciliation response is invalid or incomplete");
    }
    const hashes = new Set<`0x${string}`>();
    for (const candidate of result.events) {
      if (!candidate || typeof candidate !== "object") throw new Error("invalid contract event response");
      const event = candidate as Record<string, unknown>;
      if (event.type !== "contract" || event.contractId !== contractId || event.ledger !== ledger ||
        !Array.isArray(event.topic) || event.topic.length !== 2 ||
        event.topic[0] !== kindTopic || event.topic[1] !== commitmentTopic ||
        event.inSuccessfulContractCall === false) continue;
      if (typeof event.txHash !== "string" || !/^[0-9a-f]{64}$/i.test(event.txHash)) {
        throw new Error("contract event is missing a valid transaction hash");
      }
      hashes.add(`0x${event.txHash.toLowerCase()}`);
    }
    if (hashes.size !== 1) throw new Error("paired close event was not found uniquely; reconciliation required");
    return [...hashes][0]!;
  }

  private async readRpcResult(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.config.rpcUrl) throw new Error("RPC URL is required for transaction reconciliation");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        const response = await fetch(this.config.rpcUrl!, {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!response.ok) throw new Error(`transaction reconciliation RPC status ${response.status}`);
        const body = await response.json() as { error?: unknown; result?: unknown };
        if (body.error) throw new Error("transaction reconciliation RPC returned an error");
        if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) {
          throw new Error("transaction reconciliation RPC returned an invalid result");
        }
        return body.result as Record<string, unknown>;
      };
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("transaction reconciliation deadline exceeded")); }, this.commandTimeoutMs());
      })]);
    } finally { clearTimeout(timer); }
  }

  private sourceKey(source?: string): string {
    return `${this.config.networkPassphrase ?? this.config.network}:${source ?? this.config.source}`;
  }

  private assertSourceAvailable(source?: string): void {
    if (this.config.mode === "stellar-cli" && SOURCE_SUBMISSIONS.has(this.sourceKey(source))) {
      throw new Error("source account has a pending submission; use the asynchronous relay");
    }
  }

  private commandRunnerAsync(): AsyncCommandRunner {
    return this.asyncCommandRunner ?? (this.usesDefaultCommandRunner
      ? (command, args, timeoutMs) => runCommandAsync([command, ...args], timeoutMs)
      : async (command, args) => this.runCommand(command, args));
  }

  private commandTimeoutMs(): number {
    return this.config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  submitSignedXdr(input: SignedXdrRelayInput): RelayedTx {
    this.assertSourceAvailable(input.submittedBy);
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
    if (signedTxHash && txHash && txHash !== signedTxHash) {
      throw new Error("submitted transaction hash does not match signed transaction; reconciliation required");
    }
    if (command && output?.status === 0 && this.usesDefaultCommandRunner) {
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
    throwIfAborted(request.signal);
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
      stdout: output.stdout,
    };
  }

  async readAsync(request: RelayRequest): Promise<ContractReadResult> {
    throwIfAborted(request.signal);
    if (this.config.mode !== "stellar-cli") {
      return this.read(request);
    }
    const payload = parseInvokePayload(request.payload);
    const command = stellarInvokeCommand(this.config, { ...payload, send: "no" });
    if (commandSendMode(command) !== "no") {
      throw new Error("contract reads require --send no");
    }
    const output = await runCommandWithRetryAsync(command, this.commandTimeoutMs(), this.commandRunnerAsync(), request.signal);
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
      stdout: output.stdout,
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

export class JournaledRelayError extends Error {
  constructor(readonly txHash: `0x${string}`, message: string) {
    super(message);
    this.name = "JournaledRelayError";
  }
}

// Stellar-contract.x defines SCV_BYTES=13 and SCV_SYMBOL=15 as length-prefixed opaque values.
function scValOpaqueTopic(type: 13 | 15, value: Buffer): string {
  const encoded = Buffer.alloc(8 + Math.ceil(value.length / 4) * 4);
  encoded.writeUInt32BE(type, 0);
  encoded.writeUInt32BE(value.length, 4);
  value.copy(encoded, 8);
  return encoded.toString("base64");
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
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
  return {
    status: result.status,
    stderr: result.error?.message
      ? `${result.stderr}${result.stderr ? "\n" : ""}${result.error.message}`
      : result.stderr,
    stdout: result.stdout,
  };
}

// A CLI invoke rebuilds and signs a new transaction. Only explicit sequence rejection
// is safe to retry; a lost response can still correspond to a committed mutation.
function mayRetryCommand(command: string[], output: CommandResult): boolean {
  if (!isTransientStellarFailure(output)) return false;
  if (!sendsTransaction(command)) return true;
  return command[1] === "contract" &&
    /transaction submission failed:\s*(?:TxBadSeq|tx_bad_seq)\b/i.test(commandOutput(output)) &&
    !/timeout|timed out/i.test(commandOutput(output));
}

function runCommandWithRetry(runCommand: CommandRunner, command: string[]): CommandResult {
  let output = runCommand(command[0], command.slice(1));
  for (let attempt = 1; attempt < 4 && mayRetryCommand(command, output); attempt += 1) {
    sleep(2_500 * attempt);
    output = runCommand(command[0], command.slice(1));
  }
  return output;
}

async function runCommandWithRetryAsync(
  command: string[],
  timeoutMs: number,
  runCommand: AsyncCommandRunner,
  signal?: AbortSignal,
): Promise<CommandResult> {
  throwIfAborted(signal);
  let output = await runCommand(command[0], command.slice(1), timeoutMs);
  for (let attempt = 1; attempt < 4 && mayRetryCommand(command, output); attempt += 1) {
    await delay(2_500 * attempt);
    throwIfAborted(signal);
    output = await runCommand(command[0], command.slice(1), timeoutMs);
  }
  return output;
}

const SOURCE_SUBMISSIONS = new Map<string, Promise<unknown>>();

async function queueSubmission<T>(key: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const previous = SOURCE_SUBMISSIONS.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => {
    throwIfAborted(signal);
    return work();
  });
  SOURCE_SUBMISSIONS.set(key, task);
  try { return await task; }
  finally { if (SOURCE_SUBMISSIONS.get(key) === task) SOURCE_SUBMISSIONS.delete(key); }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("relay operation aborted before submission");
}

function runCommandAsync(command: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      nodeRuntime(),
      [RELAYER_COMMAND_WORKER, JSON.stringify(command), String(timeoutMs)],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: 600_000,
        timeout: timeoutMs + 2_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            status: typeof error.code === "number" ? error.code : null,
            stderr: [stderr, error.message].filter(Boolean).join("\n"),
            stdout: "",
          });
          return;
        }
        resolve(parseRelayWorkerResult(stdout));
      },
    );
  });
}

export async function readStellarCommandAsync(
  command: string[], timeoutMs: number, signal?: AbortSignal,
): Promise<CommandResult> {
  if (sendsTransaction(command)) throw new Error("read command must not submit a transaction");
  throwIfAborted(signal);
  const output = await runCommandAsync(command, timeoutMs);
  throwIfAborted(signal);
  return output;
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
    text.includes("rate limit") ||
    text.includes("request rejected");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sendsTransaction(command: string[]): boolean {
  return (command[1] === "tx" && command[2] === "send") ||
    (command[1] === "contract" && command[2] === "invoke" && commandSendMode(command) !== "no");
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

  const match = output.trim().match(/^(?:0x)?([0-9a-fA-F]{64})$/) ??
    output.match(/(?:transaction hash(?: is)?|txHash|transactionHash|transaction_hash)["'\s:=]+(?:0x)?([0-9a-fA-F]{64})(?:$|[^0-9a-fA-F])/i);
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
  for (const key of ["hash", "txHash", "transactionHash", "transaction_hash"] as const) {
    const found = findTxHash(record[key]);
    if (found) return found;
  }
  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== "object") continue;
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
