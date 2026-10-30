import { spawnSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stellarSignedMessageHash } from "@/features/auth/auth.service";

export const NETWORK = "Test SDF Network ; September 2015";
export const MASTER = "GDOAJNRAE4ODHFMDTTYSMS6X4PYKCMQI2KVBLO4VUDMSCO6GVTRDBS4B";
export const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const HORIZON = "https://horizon-testnet.stellar.org";
const networkArgs = ["--network", "testnet", "--network-passphrase", NETWORK];

export interface FundingAction { id: string; hash: string; signedXdr: string; preparedAt: number; confirmedAt?: number; failedAt?: number; }
export interface WalletRecord { source: string; address: string; funding: FundingAction[]; protocol?: unknown; }

function cli(args: string[], stdin?: string): string {
  const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "stellar");
  const result = spawnSync("stellar", [...args, "--config-dir", configDir], { input: stdin, encoding: "utf8", timeout: 120_000,
    env: process.env,
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  // CLI error streams can include raw envelopes. Never forward them to logs or email.
  if (result.status !== 0) throw new Error(`Stellar CLI ${args.slice(0, 3).join(" ")} failed; reconcile the saved transaction`);
  return result.stdout.trim();
}

export function createWalletIdentity(source: string): WalletRecord {
  if (!/^pnlx-observation-[a-z0-9-]+$/.test(source)) throw new Error("invalid observation wallet alias");
  let address: string;
  try { address = cli(["keys", "address", source]); }
  catch { cli(["keys", "generate", source]); address = cli(["keys", "address", source]); }
  if (!/^G[A-Z2-7]{55}$/.test(address)) throw new Error("invalid generated wallet address");
  chmodSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "stellar/identity", `${source}.toml`), 0o600);
  return { source, address, funding: [] };
}

export function walletIdentity(wallet: WalletRecord) {
  if (cli(["keys", "address", wallet.source]) !== wallet.address) throw new Error("wallet alias address mismatch");
  return {
    source: wallet.source, address: wallet.address,
    async signMessage(message: string): Promise<string> {
      const secret = cli(["keys", "secret", wallet.source]);
      return sign(null, stellarSignedMessageHash(message), privateKey(secret)).toString("base64");
    },
    async signTransaction(xdr: string, passphrase: string): Promise<string> {
      if (passphrase !== NETWORK) throw new Error("observation signer is restricted to Testnet");
      return cli(["tx", "sign", "--sign-with-key", wallet.source, ...networkArgs, "--auto-sign"], xdr);
    },
  };
}

export async function accountBalances(address: string): Promise<{ XLM: string; USDC: string; exists: boolean; trustline: boolean }> {
  const response = await fetch(`${HORIZON}/accounts/${address}`, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return { XLM: "0", USDC: "0", exists: false, trustline: false };
  if (!response.ok) throw new Error(`Testnet account lookup failed (${response.status})`);
  const account = await response.json() as { balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; balance: string; is_authorized?: boolean }> };
  const token = account.balances.find((b) => b.asset_code === "USDC" && b.asset_issuer === ISSUER);
  return { exists: true, XLM: account.balances.find((b) => b.asset_type === "native")?.balance ?? "0",
    USDC: token?.balance ?? "0", trustline: !!token && token.is_authorized !== false };
}

export async function fundWallet(wallet: WalletRecord, persist: () => Promise<void>, neededUsdc = 250): Promise<void> {
  if (cli(["keys", "address", "pnlx-observation-funder"]) !== MASTER) throw new Error("master signer mismatch");
  for (const pending of wallet.funding.filter((a) => !a.confirmedAt)) await reconcile(pending);
  let balance = await accountBalances(wallet.address);
  if (!balance.exists) {
    await transact("create", "pnlx-observation-funder", ["create-account", "--destination", wallet.address, "--starting-balance", "250000000"]);
    balance = await accountBalances(wallet.address);
  }
  if (!balance.trustline) {
    await transact("trustline", wallet.source, ["change-trust", "--line", `USDC:${ISSUER}`, "--limit", "1000000000000"]);
    balance = await accountBalances(wallet.address);
  }
  if (Number(balance.XLM) < 5) await transact("xlm-topup", "pnlx-observation-funder", ["payment", "--destination", wallet.address, "--amount", "200000000"]);
  if (Number(balance.USDC) < neededUsdc) {
    const master = await accountBalances(MASTER);
    const amount = Math.ceil(neededUsdc - Number(balance.USDC));
    if (amount > 500 || Number(master.USDC) < amount + 100) throw new Error("master test-USDC reserve is too low");
    await transact("usdc-topup", "pnlx-observation-funder", ["payment", "--destination", wallet.address,
      "--asset", `USDC:${ISSUER}`, "--amount", String(BigInt(amount) * 10_000_000n)]);
  }

  async function transact(kind: string, source: string, operation: string[]) {
    const unsigned = cli(["tx", "new", ...operation, "--source", source, ...networkArgs, "--build-only"]);
    const signedXdr = cli(["tx", "sign", "--sign-with-key", source, ...networkArgs, "--auto-sign"], unsigned);
    const hash = cli(["tx", "hash", ...networkArgs], signedXdr).replace(/^"|"$/g, "");
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("invalid funding transaction hash");
    const action = { id: `${wallet.source}:${kind}:${wallet.funding.length}`, hash, signedXdr, preparedAt: Date.now() };
    wallet.funding.push(action);
    await persist(); // No network submission before durable signed transaction recovery.
    await reconcile(action);
  }
  async function reconcile(action: FundingAction) {
    if (action.failedAt) throw new Error(`funding transaction ${action.hash} failed on chain; intervention is required`);
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(`${HORIZON}/transactions/${action.hash}`, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) {
        const tx = await response.json() as { successful: boolean; created_at: string };
        if (!tx.successful) { action.failedAt = Date.now(); await persist(); throw new Error(`funding transaction ${action.hash} failed on chain`); }
        action.confirmedAt = Date.parse(tx.created_at);
        await persist();
        return;
      }
      if (response.status !== 404) throw new Error(`funding reconciliation unavailable (${response.status})`);
      // Exact replay is safe: hash, sequence number and signed envelope do not change.
      if (attempt === 0) { try { cli(["tx", "send", ...networkArgs], action.signedXdr); } catch { /* Poll the known hash after uncertain responses. */ } }
      await Bun.sleep(5_000);
    }
    throw new Error(`funding confirmation pending for ${action.hash}`);
  }
}

function privateKey(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const c of secret) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) throw new Error("invalid signing key");
    value = (value << 5) | digit; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  const raw = Buffer.from(bytes);
  let crc = 0;
  for (const b of raw.subarray(0, 33)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  if (raw.length !== 35 || raw[0] !== 144 || raw[33] !== (crc & 255) || raw[34] !== crc >>> 8) throw new Error("invalid signing key checksum");
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw.subarray(1, 33)]), format: "der", type: "pkcs8" });
}
