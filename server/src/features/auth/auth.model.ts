export interface AuthChallengeInput {
  address: string;
  domain?: string;
  uri?: string;
}

export interface AuthChallengeResult {
  address: string;
  domain: string;
  expiresAt: number;
  message: string;
  networkPassphrase: string;
  nonce: string;
  ownerCommitment: `0x${string}`;
  signingMode: "stellar-ed25519-message";
  uri: string;
}

export interface AuthSessionInput {
  address: string;
  nonce: string;
  signature: string;
}

export interface AuthSessionResult {
  address: string;
  expiresAt: number;
  networkPassphrase: string;
  ownerCommitment: `0x${string}`;
  signingMode: "stellar-ed25519-message";
  token: string;
}

export interface AuthSession {
  address: string;
  expiresAt: number;
}
