#![no_std]

use soroban_sdk::{contractclient, Address, BytesN, Env};

#[contractclient(name = "ProofLedgerClient")]
pub trait ProofLedgerInterface {
    fn record(
        env: Env,
        verifier_authority: Address,
        circuit_id: BytesN<32>,
        verifier_hash: BytesN<32>,
        public_input_hash: BytesN<32>,
        proof_digest: BytesN<32>,
    );

    fn has_proof(
        env: Env,
        circuit_id: BytesN<32>,
        verifier_hash: BytesN<32>,
        public_input_hash: BytesN<32>,
        proof_digest: BytesN<32>,
    ) -> bool;
}
