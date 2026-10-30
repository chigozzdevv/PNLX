import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const AAD = Buffer.from("PNLX observation state v1");

export function sealState(value: unknown, key: Buffer): string {
  if (key.length !== 32) throw new Error("state encryption key must contain 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ version: 1, nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
}

export function unsealState<T>(envelope: string, key: Buffer): T {
  const data = JSON.parse(envelope);
  if (data.version !== 1 || key.length !== 32) throw new Error("unsupported encrypted observation state");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(data.nonce, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(data.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext, "base64")),
    decipher.final()]).toString("utf8")) as T;
}

/** Caller holds the process flock. Failed authentication never falls back to older financial state. */
export class ObservationStore<T> {
  private tail: Promise<void> = Promise.resolve();
  readonly filename: string;
  constructor(filename: string, private key: Buffer) { this.filename = resolve(filename); }
  exists(): boolean { return existsSync(this.filename); }
  read(): T { return unsealState<T>(readFileSync(this.filename, "utf8"), this.key); }
  write(value: T): Promise<void> {
    // Capture now: concurrent workers may continue mutating their in-memory records.
    const encrypted = sealState(value, this.key);
    const next = this.tail.then(() => {
      const directory = dirname(this.filename);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temp = `${this.filename}.tmp`;
      const fd = openSync(temp, "w", 0o600);
      try { writeFileSync(fd, encrypted); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.filename);
      const directoryFd = openSync(directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    });
    this.tail = next;
    return next;
  }
}
