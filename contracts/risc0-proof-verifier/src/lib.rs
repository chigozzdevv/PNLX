#![no_std]

use governance_interface::GovernanceClient;
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, IntoVal,
};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Governance,
    ProofLedger,
    Router,
    CircuitId,
    VerifierHash,
}

#[contract]
pub struct Risc0ProofVerifier;

#[contractimpl]
impl Risc0ProofVerifier {
    pub fn init(
        env: Env,
        governance: Address,
        proof_ledger: Address,
        router: Address,
        circuit_id: BytesN<32>,
        verifier_hash: BytesN<32>,
    ) {
        validate_hash(&env, &circuit_id);
        validate_hash(&env, &verifier_hash);
        if env.storage().instance().has(&DataKey::Governance) {
            panic!("already initialized");
        }
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
        env.storage()
            .instance()
            .set(&DataKey::ProofLedger, &proof_ledger);
        env.storage().instance().set(&DataKey::Router, &router);
        env.storage()
            .instance()
            .set(&DataKey::CircuitId, &circuit_id);
        env.storage()
            .instance()
            .set(&DataKey::VerifierHash, &verifier_hash);
    }

    pub fn verify_and_record(
        env: Env,
        seal: Bytes,
        image_id: BytesN<32>,
        journal_digest: BytesN<32>,
        proof_digest: BytesN<32>,
    ) {
        validate_hash(&env, &image_id);
        validate_hash(&env, &journal_digest);
        validate_hash(&env, &proof_digest);
        if env.crypto().sha256(&seal).to_bytes() != proof_digest {
            panic!("proof digest mismatch");
        }

        let governance_id = Self::governance(env.clone());
        let governance = GovernanceClient::new(&env, &governance_id);
        let circuit_id = Self::circuit_id(env.clone());
        let verifier_hash = Self::verifier_hash(env.clone());
        let authority = env.current_contract_address();
        if governance.paused() {
            panic!("paused");
        }
        if governance.verifier(&circuit_id) != verifier_hash {
            panic!("verifier mismatch");
        }
        if governance.verifier_authority(&circuit_id) != authority {
            panic!("unauthorized verifier");
        }

        env.invoke_contract::<()>(
            &Self::router(env.clone()),
            &symbol_short!("verify"),
            (seal, image_id, journal_digest.clone()).into_val(&env),
        );

        ProofLedgerClient::new(&env, &Self::proof_ledger(env.clone())).record(
            &authority,
            &circuit_id,
            &verifier_hash,
            &journal_digest,
            &proof_digest,
        );
    }

    pub fn governance(env: Env) -> Address {
        get_address(&env, DataKey::Governance)
    }

    pub fn proof_ledger(env: Env) -> Address {
        get_address(&env, DataKey::ProofLedger)
    }

    pub fn router(env: Env) -> Address {
        get_address(&env, DataKey::Router)
    }

    pub fn circuit_id(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::CircuitId)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn verifier_hash(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::VerifierHash)
            .unwrap_or_else(|| panic!("not initialized"))
    }
}

fn get_address(env: &Env, key: DataKey) -> Address {
    env.storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| panic!("not initialized"))
}

fn validate_hash(env: &Env, value: &BytesN<32>) {
    if *value == BytesN::from_array(env, &[0; 32]) {
        panic!("invalid proof");
    }
}
