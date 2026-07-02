import { ownerCommitment } from "@pnlx/crypto";
import type { Hex } from "@pnlx/protocol-types";

const authenticatedAddresses = new WeakMap<Request, string>();
const authenticatedContexts = new WeakMap<Request, AuthContext>();

export interface AuthContext {
  address: string;
  expiresAt?: number;
}

export function setAuthenticatedAddress(request: Request, address: string): void {
  authenticatedAddresses.set(request, normalizeAddress(address));
}

export function setAuthenticatedContext(request: Request, context: AuthContext): void {
  const normalized = normalizeAddress(context.address);
  authenticatedAddresses.set(request, normalized);
  authenticatedContexts.set(request, { ...context, address: normalized });
}

export function authenticatedAddress(request: Request): string | undefined {
  return authenticatedAddresses.get(request);
}

export function authenticatedContext(request: Request): AuthContext | undefined {
  return authenticatedContexts.get(request);
}

export function assertAuthenticatedAccount(
  authenticated: string | undefined,
  account: string | undefined,
  field: string,
): void {
  if (!authenticated || !account) return;
  if (normalizeAddress(account) !== normalizeAddress(authenticated)) {
    throw new Error(`${field} does not match authenticated account`);
  }
}

export function assertAuthenticatedOwnerCommitment(
  authenticated: string | undefined,
  commitment: Hex | undefined,
  field: string,
): void {
  if (!authenticated || !commitment) return;
  if (ownerCommitment(normalizeAddress(authenticated)).toLowerCase() !== commitment.toLowerCase()) {
    throw new Error(`${field} does not match authenticated account`);
  }
}

export function assertProtocolAdmin(
  authenticated: string | undefined,
  admins: string[],
  options: { required?: boolean } = {},
): void {
  if (options.required && admins.length === 0) {
    throw new Error("protocol admin addresses are not configured");
  }
  if (options.required && !authenticated) {
    throw new Error("protocol admin authentication is required");
  }
  if (!authenticated || admins.length === 0) return;
  const normalized = normalizeAddress(authenticated);
  if (!admins.map(normalizeAddress).includes(normalized)) {
    throw new Error("authenticated account is not a protocol admin");
  }
}

function normalizeAddress(address: string): string {
  return address.trim().toUpperCase();
}
